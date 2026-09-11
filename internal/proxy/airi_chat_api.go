package proxy

// AIRI MVP chat API.
//
// This file exposes a machine-facing HTTP surface (/v1/airi/...) over exactly
// the same Notion chat plumbing the dashboard drives through /admin/chat/*.
// An MCP client can therefore pick a workspace, open a chat, post a task and
// poll for the answer without ever holding a dashboard session.
//
// Two design choices keep this thin:
//
//  1. Re-dispatch instead of re-implementation. chatAuthOK is nil-safe, so the
//     existing handlers constructed with a nil *DashboardAuth skip the session
//     check and run their normal logic. Every /v1/ path is already guarded by
//     the API-key middleware, so the AIRI key is the only credential needed.
//     All the Notion payload building, NDJSON parsing and overage handling
//     stays in one place.
//
//  2. Asynchronous turns. A Notion turn can outlive an MCP client's request
//     timeout, so POSTing a message starts a background task and returns a
//     chat_id plus a task_id immediately. buildSendPayload reuses
//     pending_thread_id as the new thread's id, which is what lets us hand out
//     the chat_id before the turn has even started.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---- response helpers ----

// airiCapture is a minimal in-memory http.ResponseWriter used to call an
// existing handler and reshape its response before it reaches the client.
type airiCapture struct {
	hdr    http.Header
	status int
	buf    bytes.Buffer
}

func newAiriCapture() *airiCapture {
	return &airiCapture{hdr: make(http.Header), status: http.StatusOK}
}

func (c *airiCapture) Header() http.Header         { return c.hdr }
func (c *airiCapture) Write(p []byte) (int, error) { return c.buf.Write(p) }
func (c *airiCapture) WriteHeader(code int)        { c.status = code }
func (c *airiCapture) Flush()                      {}

func (c *airiCapture) ok() bool { return c.status >= 200 && c.status < 300 }

func airiJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("[airi-api] encode response: %v", err)
	}
}

// airiFail emits the same error envelope as the rest of the /v1 surface.
func airiFail(w http.ResponseWriter, status int, kind, msg string) {
	airiJSON(w, status, map[string]any{
		"error": map[string]string{"message": msg, "type": kind},
	})
}

// airiProxy forwards a captured response to the real client unchanged.
func airiProxy(w http.ResponseWriter, c *airiCapture) {
	for k, vv := range c.hdr {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(c.status)
	if _, err := w.Write(c.buf.Bytes()); err != nil {
		log.Printf("[airi-api] write response: %v", err)
	}
}

// airiForward passes successes through and translates the admin handlers'
// {"error":"..."} shape into the /v1 error envelope.
func airiForward(w http.ResponseWriter, c *airiCapture) {
	if c.ok() {
		airiProxy(w, c)
		return
	}
	msg := strings.TrimSpace(string(c.buf.Bytes()))
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(c.buf.Bytes(), &e) == nil && strings.TrimSpace(e.Error) != "" {
		msg = strings.TrimSpace(e.Error)
	}
	kind := "upstream_error"
	if c.status == http.StatusBadRequest {
		kind = "invalid_request_error"
	}
	airiFail(w, c.status, kind, truncate(msg, 500))
}

// airiInvoke runs one of the /admin/chat/* handlers with a synthetic JSON body.
// Pass ctxReq to inherit the caller's context and headers; pass nil for
// background work that must outlive the originating HTTP request.
func airiInvoke(h http.HandlerFunc, ctxReq *http.Request, payload map[string]any) *airiCapture {
	c := newAiriCapture()
	raw, err := json.Marshal(payload)
	if err != nil {
		c.status = http.StatusInternalServerError
		c.buf.WriteString(`{"error":"cannot encode internal request"}`)
		return c
	}
	var inner *http.Request
	if ctxReq != nil {
		inner = ctxReq.Clone(ctxReq.Context())
		inner.Header = ctxReq.Header.Clone()
	} else {
		inner, err = http.NewRequest(http.MethodPost, "http://127.0.0.1/admin/chat/dispatch", nil)
		if err != nil {
			c.status = http.StatusInternalServerError
			c.buf.WriteString(`{"error":"cannot build internal request"}`)
			return c
		}
	}
	if inner.Header == nil {
		inner.Header = make(http.Header)
	}
	// chatAuthOK only insists on POST, so normalise the verb here: the public
	// route may well be a GET or a DELETE.
	inner.Method = http.MethodPost
	inner.Body = io.NopCloser(bytes.NewReader(raw))
	inner.ContentLength = int64(len(raw))
	inner.Header.Set("Content-Type", "application/json")
	h(c, inner)
	return c
}

// ---- small parsing helpers ----

func airiStr(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

func airiCanonicalID(s string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(s), "-", ""))
}

func airiQueryBool(r *http.Request, key string) bool {
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get(key))) {
	case "1", "true", "yes", "y", "on":
		return true
	}
	return false
}

func airiQueryFloat(r *http.Request, key string) float64 {
	v := strings.TrimSpace(r.URL.Query().Get(key))
	if v == "" {
		return 0
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return 0
	}
	return f
}

func airiHasRaw(raw json.RawMessage) bool {
	s := strings.TrimSpace(string(raw))
	return s != "" && s != "null" && s != "[]" && s != "{}"
}

func airiCountRaw(raw json.RawMessage) int {
	if !airiHasRaw(raw) {
		return 0
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return 0
	}
	return len(arr)
}

// ---- workspace resolution ----

// airiTarget is the set of credentials every /admin/chat/* handler expects.
type airiTarget struct {
	TokenV2     string
	UserID      string
	UserName    string
	UserEmail   string
	SpaceID     string
	SpaceViewID string
	SpaceName   string
	Timezone    string
}

// payload seeds a re-dispatched call. The handlers decode into narrow structs,
// so extra keys are ignored and one shape fits all of them.
func (t *airiTarget) payload() map[string]any {
	tz := strings.TrimSpace(t.Timezone)
	if tz == "" {
		tz = "UTC"
	}
	return map[string]any{
		"token_v2":      t.TokenV2,
		"user_id":       t.UserID,
		"user_name":     t.UserName,
		"user_email":    t.UserEmail,
		"space_id":      t.SpaceID,
		"space_view_id": t.SpaceViewID,
		"space_name":    t.SpaceName,
		"timezone":      tz,
	}
}

// airiDiscoveredAccount mirrors AccountWorkspaces through its JSON shape, which
// keeps this file decoupled from that struct's Go field names.
type airiDiscoveredAccount struct {
	UserID    string           `json:"user_id"`
	UserName  string           `json:"user_name"`
	UserEmail string           `json:"user_email"`
	TokenV2   string           `json:"token_v2"`
	Spaces    []map[string]any `json:"spaces"`
}

const airiWorkspaceTTL = 90 * time.Second

var (
	airiWsMu    sync.Mutex
	airiWsAt    time.Time
	airiWsCache []airiDiscoveredAccount
)

// airiDiscoverAll mirrors HandleListWorkspaces: snapshot the unique tokens under
// the pool read lock, then discover each account's spaces concurrently. Results
// are cached briefly so polling clients do not hammer Notion.
func airiDiscoverAll(pool *AccountPool, force bool) []airiDiscoveredAccount {
	if pool == nil {
		return nil
	}
	airiWsMu.Lock()
	defer airiWsMu.Unlock()
	if !force && airiWsCache != nil && time.Since(airiWsAt) < airiWorkspaceTTL {
		return airiWsCache
	}

	pool.mu.RLock()
	tokens := make([]string, 0, len(pool.accounts))
	seen := make(map[string]bool)
	for _, acc := range pool.accounts {
		t := strings.TrimSpace(acc.TokenV2)
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		tokens = append(tokens, t)
	}
	pool.mu.RUnlock()

	results := make([]*AccountWorkspaces, len(tokens))
	var wg sync.WaitGroup
	for i, t := range tokens {
		wg.Add(1)
		go func(idx int, token string) {
			defer wg.Done()
			aw, err := DiscoverWorkspacesFromToken(token)
			if err != nil {
				log.Printf("[airi-api] workspace discovery failed: %v", err)
				return
			}
			results[idx] = aw
		}(i, t)
	}
	wg.Wait()

	out := make([]airiDiscoveredAccount, 0, len(results))
	for _, aw := range results {
		if aw == nil {
			continue
		}
		raw, err := json.Marshal(aw)
		if err != nil {
			continue
		}
		var parsed airiDiscoveredAccount
		if err := json.Unmarshal(raw, &parsed); err != nil {
			continue
		}
		out = append(out, parsed)
	}
	airiWsCache = out
	airiWsAt = time.Now()
	return out
}

func airiWsCacheAge() time.Duration {
	airiWsMu.Lock()
	defer airiWsMu.Unlock()
	if airiWsAt.IsZero() {
		return time.Hour
	}
	return time.Since(airiWsAt)
}

func airiTimezoneFor(pool *AccountPool, token string) string {
	if pool == nil || strings.TrimSpace(token) == "" {
		return "UTC"
	}
	pool.mu.RLock()
	defer pool.mu.RUnlock()
	for _, acc := range pool.accounts {
		if acc.TokenV2 == token && strings.TrimSpace(acc.Timezone) != "" {
			return acc.Timezone
		}
	}
	return "UTC"
}

func airiMatchDiscovered(list []airiDiscoveredAccount, want string, pool *AccountPool) *airiTarget {
	for _, d := range list {
		for _, sp := range d.Spaces {
			id := airiStr(sp, "space_id")
			if id == "" || airiCanonicalID(id) != want {
				continue
			}
			return &airiTarget{
				TokenV2:     d.TokenV2,
				UserID:      d.UserID,
				UserName:    d.UserName,
				UserEmail:   d.UserEmail,
				SpaceID:     id,
				SpaceViewID: airiStr(sp, "space_view_id"),
				SpaceName:   airiStr(sp, "name"),
				Timezone:    airiTimezoneFor(pool, d.TokenV2),
			}
		}
	}
	return nil
}

// airiResolve maps a workspace_id onto a pooled account. The fast path is an
// account whose pinned space already matches; otherwise any space reachable by
// any pooled token is accepted, because the payload carries spaceId explicitly.
func airiResolve(pool *AccountPool, workspaceID string) (*airiTarget, error) {
	want := airiCanonicalID(workspaceID)
	if want == "" {
		return nil, fmt.Errorf("workspace_id is required")
	}
	if pool == nil {
		return nil, fmt.Errorf("no accounts are loaded")
	}
	if acc := pool.GetBySpaceID(strings.TrimSpace(workspaceID)); acc != nil {
		return &airiTarget{
			TokenV2:     acc.TokenV2,
			UserID:      acc.UserID,
			UserName:    acc.UserName,
			UserEmail:   acc.UserEmail,
			SpaceID:     acc.SpaceID,
			SpaceViewID: acc.SpaceViewID,
			SpaceName:   acc.SpaceName,
			Timezone:    acc.Timezone,
		}, nil
	}
	if t := airiMatchDiscovered(airiDiscoverAll(pool, false), want, pool); t != nil {
		return t, nil
	}
	// A workspace added after the cache was filled deserves one forced refresh.
	if airiWsCacheAge() > 5*time.Second {
		if t := airiMatchDiscovered(airiDiscoverAll(pool, true), want, pool); t != nil {
			return t, nil
		}
	}
	return nil, fmt.Errorf("unknown workspace_id %q", strings.TrimSpace(workspaceID))
}

// ---- asynchronous turns ----

const (
	airiStatusQueued  = "queued"
	airiStatusRunning = "running"
	airiStatusDone    = "done"
	airiStatusError   = "error"
	airiStatusSurvey  = "awaiting_survey"
	airiStatusStopped = "stopped"
	airiStatusIdle    = "idle"
)

const (
	airiTaskTTL      = 6 * time.Hour
	airiMaxWait      = 10 * time.Minute
	airiDefaultWait  = 120 * time.Second
	airiMaxBodyBytes = 1 << 20
)

type airiTask struct {
	ID          string
	ChatID      string
	WorkspaceID string
	Status      string
	Agent       string
	Model       string
	Message     string
	Title       string
	Answer      string
	Steps       json.RawMessage
	Blocks      json.RawMessage
	Survey      json.RawMessage
	Pages       json.RawMessage
	Error       string
	CreatedAt   int64
	StartedAt   int64
	FinishedAt  int64

	done chan struct{}
}

type airiTaskStore struct {
	mu     sync.RWMutex
	tasks  map[string]*airiTask
	byChat map[string]string
	byIdem map[string]string
}

var airiTasks = &airiTaskStore{
	tasks:  make(map[string]*airiTask),
	byChat: make(map[string]string),
	byIdem: make(map[string]string),
}

func (s *airiTaskStore) add(t *airiTask, idem string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gcLocked()
	s.tasks[t.ID] = t
	s.byChat[t.ChatID] = t.ID
	if idem != "" {
		s.byIdem[idem] = t.ID
	}
}

func (s *airiTaskStore) gcLocked() {
	cutoff := time.Now().Add(-airiTaskTTL).UnixMilli()
	for id, t := range s.tasks {
		if t.CreatedAt >= cutoff {
			continue
		}
		delete(s.tasks, id)
		if s.byChat[t.ChatID] == id {
			delete(s.byChat, t.ChatID)
		}
	}
	for k, id := range s.byIdem {
		if _, ok := s.tasks[id]; !ok {
			delete(s.byIdem, k)
		}
	}
}

func (s *airiTaskStore) get(id string) *airiTask {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.tasks[strings.TrimSpace(id)]
}

func (s *airiTaskStore) latestForChat(chatID string) *airiTask {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if id, ok := s.byChat[strings.TrimSpace(chatID)]; ok {
		return s.tasks[id]
	}
	return nil
}

func (s *airiTaskStore) forIdempotency(key string) *airiTask {
	key = strings.TrimSpace(key)
	if key == "" {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if id, ok := s.byIdem[key]; ok {
		return s.tasks[id]
	}
	return nil
}

// update is the single writer path, so snapshot readers never see a torn task.
func (s *airiTaskStore) update(t *airiTask, fn func(*airiTask)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(t)
	s.byChat[t.ChatID] = t.ID
}

func (s *airiTaskStore) snapshot(t *airiTask) airiTask {
	s.mu.RLock()
	defer s.mu.RUnlock()
	copied := *t
	copied.done = nil
	return copied
}

// airiRunTurn executes one chat turn in the background by re-dispatching to the
// dashboard's own HandleChatSend, so the Notion payload, the NDJSON parse and
// the per-turn overage window all stay in a single implementation.
func airiRunTurn(t *airiTask, payload map[string]any) {
	defer close(t.done)
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[airi-api] task %s panicked: %v", t.ID, rec)
			airiTasks.update(t, func(x *airiTask) {
				x.Status = airiStatusError
				x.Error = fmt.Sprintf("internal error: %v", rec)
				x.FinishedAt = time.Now().UnixMilli()
			})
		}
	}()

	airiTasks.update(t, func(x *airiTask) {
		x.Status = airiStatusRunning
		x.StartedAt = time.Now().UnixMilli()
	})

	c := airiInvoke(HandleChatSend(nil), nil, payload)
	raw := c.buf.Bytes()

	var out struct {
		ThreadID string          `json:"thread_id"`
		Title    string          `json:"title"`
		Text     string          `json:"text"`
		Steps    json.RawMessage `json:"steps"`
		Blocks   json.RawMessage `json:"blocks"`
		Survey   json.RawMessage `json:"survey"`
		Pages    json.RawMessage `json:"pages"`
		Error    string          `json:"error"`
	}
	_ = json.Unmarshal(raw, &out)

	now := time.Now().UnixMilli()
	if !c.ok() {
		msg := strings.TrimSpace(out.Error)
		if msg == "" {
			msg = fmt.Sprintf("chat send failed with status %d: %s", c.status, truncate(strings.TrimSpace(string(raw)), 400))
		}
		airiTasks.update(t, func(x *airiTask) {
			x.Status = airiStatusError
			x.Error = msg
			x.FinishedAt = now
		})
		return
	}

	status := airiStatusDone
	if airiHasRaw(out.Survey) {
		status = airiStatusSurvey
	}
	airiTasks.update(t, func(x *airiTask) {
		x.Status = status
		x.Title = strings.TrimSpace(out.Title)
		x.Answer = out.Text
		x.Steps = out.Steps
		x.Blocks = out.Blocks
		x.Survey = out.Survey
		x.Pages = out.Pages
		x.FinishedAt = now
		// The minted pending id is normally what comes back, but stay in sync if
		// Notion ever hands over a different thread id.
		if id := strings.TrimSpace(out.ThreadID); id != "" {
			x.ChatID = id
		}
	})
}

func airiSeconds(v float64, def time.Duration) time.Duration {
	if v <= 0 {
		return def
	}
	d := time.Duration(v * float64(time.Second))
	if d > airiMaxWait {
		return airiMaxWait
	}
	return d
}

func airiWait(r *http.Request, t *airiTask, d time.Duration) {
	if d <= 0 {
		return
	}
	if d > airiMaxWait {
		d = airiMaxWait
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-t.done:
	case <-timer.C:
	case <-r.Context().Done():
	}
}

func airiTaskView(t *airiTask, includeResult bool) map[string]any {
	view := map[string]any{
		"task_id":      t.ID,
		"chat_id":      t.ChatID,
		"workspace_id": t.WorkspaceID,
		"status":       t.Status,
		"created_at":   t.CreatedAt,
	}
	if t.Agent != "" {
		view["agent"] = t.Agent
	}
	if t.Model != "" {
		view["model"] = t.Model
	}
	if t.Title != "" {
		view["title"] = t.Title
	}
	if t.StartedAt > 0 {
		view["started_at"] = t.StartedAt
	}
	if t.FinishedAt > 0 {
		view["finished_at"] = t.FinishedAt
	}
	if t.Error != "" {
		view["error"] = t.Error
	}
	if n := airiCountRaw(t.Steps); n > 0 {
		view["steps_done"] = n
	}
	if includeResult {
		if t.Answer != "" {
			view["answer"] = t.Answer
			view["answer_markdown"] = t.Answer
		}
		if airiHasRaw(t.Steps) {
			view["steps"] = t.Steps
		}
		if airiHasRaw(t.Blocks) {
			view["blocks"] = t.Blocks
		}
		if airiHasRaw(t.Survey) {
			view["survey"] = t.Survey
		}
		if airiHasRaw(t.Pages) {
			view["pages"] = t.Pages
		}
	}
	return view
}

// ---- routing scaffolding ----

// airiWorkspaceScoped resolves {workspace_id} (path first, query as a fallback).
func airiWorkspaceScoped(pool *AccountPool, fn func(http.ResponseWriter, *http.Request, *airiTarget)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSpace(r.PathValue("workspace_id"))
		if id == "" {
			id = strings.TrimSpace(r.URL.Query().Get("workspace_id"))
		}
		if id == "" {
			airiFail(w, http.StatusBadRequest, "invalid_request_error", "workspace_id is required")
			return
		}
		target, err := airiResolve(pool, id)
		if err != nil {
			airiFail(w, http.StatusNotFound, "invalid_request_error", err.Error())
			return
		}
		fn(w, r, target)
	}
}

// airiChatScoped resolves {chat_id} plus the workspace it belongs to. The
// workspace may arrive as a query parameter or a body field, and for a chat this
// server already ran a turn on it can be recovered from the task store.
func airiChatScoped(pool *AccountPool, fn func(http.ResponseWriter, *http.Request, *airiTarget, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		chatID := strings.TrimSpace(r.PathValue("chat_id"))
		if chatID == "" {
			airiFail(w, http.StatusBadRequest, "invalid_request_error", "chat_id is required")
			return
		}
		wsID := strings.TrimSpace(r.URL.Query().Get("workspace_id"))
		if r.Body != nil && r.Method != http.MethodGet {
			raw, err := io.ReadAll(io.LimitReader(r.Body, airiMaxBodyBytes))
			r.Body.Close()
			if err != nil {
				airiFail(w, http.StatusBadRequest, "invalid_request_error", "cannot read request body")
				return
			}
			if len(raw) > 0 && wsID == "" {
				var probe struct {
					WorkspaceID string `json:"workspace_id"`
					SpaceID     string `json:"space_id"`
				}
				if json.Unmarshal(raw, &probe) == nil {
					if wsID = strings.TrimSpace(probe.WorkspaceID); wsID == "" {
						wsID = strings.TrimSpace(probe.SpaceID)
					}
				}
			}
			// Put the body back so the real handler can decode it again.
			r.Body = io.NopCloser(bytes.NewReader(raw))
			r.ContentLength = int64(len(raw))
		}
		if wsID == "" {
			if prev := airiTasks.latestForChat(chatID); prev != nil {
				snap := airiTasks.snapshot(prev)
				wsID = snap.WorkspaceID
			}
		}
		if wsID == "" {
			airiFail(w, http.StatusBadRequest, "invalid_request_error",
				"workspace_id is required (pass ?workspace_id= or a workspace_id body field)")
			return
		}
		target, err := airiResolve(pool, wsID)
		if err != nil {
			airiFail(w, http.StatusNotFound, "invalid_request_error", err.Error())
			return
		}
		fn(w, r, target, chatID)
	}
}

// ---- handlers ----

// HandleAIRIWorkspaces lists every workspace reachable with the pooled tokens.
// GET /v1/airi/workspaces[?refresh=true]
func HandleAIRIWorkspaces(pool *AccountPool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accounts := airiDiscoverAll(pool, airiQueryBool(r, "refresh"))
		out := make([]map[string]any, 0, 8)
		for _, acc := range accounts {
			for _, sp := range acc.Spaces {
				item := make(map[string]any, len(sp)+3)
				for k, v := range sp {
					// Never echo credentials on a machine-facing endpoint.
					if k == "token_v2" || k == "full_cookie" {
						continue
					}
					item[k] = v
				}
				item["workspace_id"] = airiStr(sp, "space_id")
				item["account_email"] = acc.UserEmail
				item["account_user_id"] = acc.UserID
				out = append(out, item)
			}
		}
		airiJSON(w, http.StatusOK, map[string]any{"workspaces": out, "count": len(out)})
	}
}

// HandleAIRIWorkspaceAgents lists the default plus custom agents of a workspace.
// GET /v1/airi/workspaces/{workspace_id}/agents
func HandleAIRIWorkspaceAgents(pool *AccountPool) http.HandlerFunc {
	return airiWorkspaceScoped(pool, func(w http.ResponseWriter, r *http.Request, t *airiTarget) {
		airiForward(w, airiInvoke(HandleChatAgents(nil), r, t.payload()))
	})
}

// HandleAIRIWorkspaceModels lists the models a workspace may select.
// GET /v1/airi/workspaces/{workspace_id}/models
func HandleAIRIWorkspaceModels(pool *AccountPool) http.HandlerFunc {
	return airiWorkspaceScoped(pool, func(w http.ResponseWriter, r *http.Request, t *airiTarget) {
		airiForward(w, airiInvoke(HandleChatModels(nil), r, t.payload()))
	})
}

// HandleAIRIListChats lists a workspace's chats.
// GET /v1/airi/workspaces/{workspace_id}/chats
func HandleAIRIListChats(pool *AccountPool) http.HandlerFunc {
	return airiWorkspaceScoped(pool, func(w http.ResponseWriter, r *http.Request, t *airiTarget) {
		c := airiInvoke(HandleChatThreads(nil), r, t.payload())
		if !c.ok() {
			airiForward(w, c)
			return
		}
		var parsed struct {
			Threads json.RawMessage `json:"threads"`
		}
		if err := json.Unmarshal(c.buf.Bytes(), &parsed); err != nil || !airiHasRaw(parsed.Threads) {
			airiProxy(w, c)
			return
		}
		airiJSON(w, http.StatusOK, map[string]any{
			"workspace_id": t.SpaceID,
			"chats":        parsed.Threads,
		})
	})
}

type airiTurnBody struct {
	Message         string  `json:"message"`
	Agent           string  `json:"agent"`
	Model           string  `json:"model"`
	ReasoningEffort string  `json:"reasoning_effort"`
	ContextPageID   string  `json:"context_page_id"`
	Wait            bool    `json:"wait"`
	TimeoutSec      float64 `json:"timeout_sec"`
	IdempotencyKey  string  `json:"idempotency_key"`
	ClientTaskID    string  `json:"client_task_id"`
}

// airiStartTurn queues one chat turn. An empty chatID opens a new chat, in which
// case the id is minted here and handed to Notion as pending_thread_id so the
// caller can start polling immediately.
func airiStartTurn(w http.ResponseWriter, r *http.Request, t *airiTarget, chatID string) {
	var body airiTurnBody
	if r.Body != nil {
		if err := json.NewDecoder(io.LimitReader(r.Body, airiMaxBodyBytes)).Decode(&body); err != nil && err != io.EOF {
			airiFail(w, http.StatusBadRequest, "invalid_request_error", "invalid JSON body: "+err.Error())
			return
		}
	}
	msg := strings.TrimSpace(body.Message)
	if msg == "" {
		airiFail(w, http.StatusBadRequest, "invalid_request_error", "message is required")
		return
	}

	idem := strings.TrimSpace(body.IdempotencyKey)
	if idem == "" {
		idem = strings.TrimSpace(body.ClientTaskID)
	}
	if idem == "" {
		idem = strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	}
	if existing := airiTasks.forIdempotency(idem); existing != nil {
		snap := airiTasks.snapshot(existing)
		airiJSON(w, http.StatusOK, airiTaskView(&snap, true))
		return
	}

	newChat := strings.TrimSpace(chatID) == ""
	if newChat {
		chatID = generateUUIDv4()
	}

	agent := strings.TrimSpace(body.Agent)
	model := strings.TrimSpace(body.Model)
	payload := t.payload()
	payload["message"] = msg
	payload["agent"] = agent
	payload["model"] = model
	payload["reasoning_effort"] = strings.TrimSpace(body.ReasoningEffort)
	payload["context_page_id"] = strings.TrimSpace(body.ContextPageID)
	if newChat {
		// buildSendPayload treats an empty thread_id as "create", and reuses
		// pending_thread_id as the new thread's id.
		payload["pending_thread_id"] = chatID
	} else {
		payload["thread_id"] = chatID
	}

	task := &airiTask{
		ID:          generateUUIDv4(),
		ChatID:      chatID,
		WorkspaceID: t.SpaceID,
		Status:      airiStatusQueued,
		Agent:       agent,
		Model:       model,
		Message:     truncate(msg, 2000),
		CreatedAt:   time.Now().UnixMilli(),
		done:        make(chan struct{}),
	}
	airiTasks.add(task, idem)
	go airiRunTurn(task, payload)

	if body.Wait {
		airiWait(r, task, airiSeconds(body.TimeoutSec, airiDefaultWait))
	}

	snap := airiTasks.snapshot(task)
	status := http.StatusAccepted
	if snap.Status != airiStatusQueued && snap.Status != airiStatusRunning {
		status = http.StatusOK
	}
	airiJSON(w, status, airiTaskView(&snap, body.Wait))
}

// HandleAIRICreateChat opens a new chat and queues its first turn.
// POST /v1/airi/workspaces/{workspace_id}/chats
func HandleAIRICreateChat(pool *AccountPool) http.HandlerFunc {
	return airiWorkspaceScoped(pool, func(w http.ResponseWriter, r *http.Request, t *airiTarget) {
		airiStartTurn(w, r, t, "")
	})
}

// HandleAIRISendMessage queues another turn in an existing chat.
// POST /v1/airi/chats/{chat_id}/messages
func HandleAIRISendMessage(pool *AccountPool) http.HandlerFunc {
	return airiChatScoped(pool, func(w http.ResponseWriter, r *http.Request, t *airiTarget, chatID string) {
		airiStartTurn(w, r, t, chatID)
	})
}

// HandleAIRIChatStatus reports whether a chat is still thinking.
// GET /v1/airi/chats/{chat_id}?workspace_id=...
func HandleAIRIChatStatus(pool *AccountPool) http.HandlerFunc {
	return airiChatScoped(pool, func(w http.ResponseWriter, r *http.Request, t *airiTarget, chatID string) {
		payload := t.payload()
		payload["thread_id"] = chatID
		if v := strings.TrimSpace(r.URL.Query().Get("since_version")); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				payload["since_version"] = n
			}
		}
		c := airiInvoke(HandleChatSync(nil), r, payload)
		if !c.ok() {
			airiForward(w, c)
			return
		}
		var state struct {
			Running  bool              `json:"running"`
			Version  int               `json:"version"`
			Outcome  string            `json:"outcome"`
			Changed  bool              `json:"changed"`
			Messages []json.RawMessage `json:"messages"`
		}
		_ = json.Unmarshal(c.buf.Bytes(), &state)

		view := map[string]any{
			"chat_id":      chatID,
			"workspace_id": t.SpaceID,
			"running":      state.Running,
			"version":      state.Version,
			"updated_at":   time.Now().UnixMilli(),
		}
		if state.Outcome != "" {
			view["outcome"] = state.Outcome
		}
		if len(state.Messages) > 0 {
			view["message_count"] = len(state.Messages)
		}

		status := airiStatusIdle
		if state.Running {
			status = airiStatusRunning
		} else if state.Outcome != "" {
			status = airiOutcomeStatus(state.Outcome)
		}
		if prev := airiTasks.latestForChat(chatID); prev != nil {
			snap := airiTasks.snapshot(prev)
			view["task_id"] = snap.ID
			view["task_status"] = snap.Status
			if snap.Title != "" {
				view["title"] = snap.Title
			}
			if n := airiCountRaw(snap.Steps); n > 0 {
				view["steps_done"] = n
			}
			if airiHasRaw(snap.Survey) {
				view["has_survey"] = true
			}
			if snap.Error != "" {
				view["error"] = snap.Error
			}
			// The task store knows about outcomes Notion has not flushed yet.
			if !state.Running {
				status = snap.Status
			}
		}
		view["status"] = status
		airiJSON(w, http.StatusOK, view)
	})
}

func airiOutcomeStatus(outcome string) string {
	normalised := strings.ToLower(strings.TrimSpace(outcome))
	switch normalised {
	case "":
		return airiStatusIdle
	case "success", "succeeded", "complete", "completed", "ok":
		return airiStatusDone
	case "stopped", "cancelled", "canceled", "aborted":
		return airiStatusStopped
	case "error", "failed", "failure":
		return airiStatusError
	default:
		return normalised
	}
}

// HandleAIRIChatResult returns the parsed answer of a tracked turn.
// GET /v1/airi/chats/{chat_id}/result[?task_id=&wait=true&timeout_sec=]
func HandleAIRIChatResult(pool *AccountPool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		chatID := strings.TrimSpace(r.PathValue("chat_id"))
		taskID := strings.TrimSpace(r.URL.Query().Get("task_id"))
		var task *airiTask
		if taskID != "" {
			task = airiTasks.get(taskID)
		} else if chatID != "" {
			task = airiTasks.latestForChat(chatID)
		}
		if task == nil {
			airiFail(w, http.StatusNotFound, "invalid_request_error",
				"no tracked turn for this chat; read the transcript with GET /v1/airi/chats/{chat_id}/messages")
			return
		}
		if airiQueryBool(r, "wait") {
			airiWait(r, task, airiSeconds(airiQueryFloat(r, "timeout_sec"), airiDefaultWait))
		}
		snap := airiTasks.snapshot(task)
		airiJSON(w, http.StatusOK, airiTaskView(&snap, true))
	}
}

// HandleAIRITaskStatus is the chat-independent view of one queued turn.
// GET /v1/airi/tasks/{task_id}[?wait=true&timeout_sec=]
func HandleAIRITaskStatus(pool *AccountPool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		task := airiTasks.get(r.PathValue("task_id"))
		if task == nil {
			airiFail(w, http.StatusNotFound, "invalid_request_error", "unknown task_id")
			return
		}
		if airiQueryBool(r, "wait") {
			airiWait(r, task, airiSeconds(airiQueryFloat(r, "timeout_sec"), airiDefaultWait))
		}
		snap := airiTasks.snapshot(task)
		airiJSON(w, http.StatusOK, airiTaskView(&snap, true))
	}
}

// HandleAIRIChatMessages returns a chat's transcript.
// GET /v1/airi/chats/{chat_id}/messages?workspace_id=...
func HandleAIRIChatMessages(pool *AccountPool) http.HandlerFunc {
	return airiChatScoped(pool, func(w http.ResponseWriter, r *http.Request, t *airiTarget, chatID string) {
		payload := t.payload()
		payload["thread_id"] = chatID
		airiForward(w, airiInvoke(HandleChatHistory(nil), r, payload))
	})
}

// HandleAIRIDeleteChat soft-deletes a chat.
// DELETE /v1/airi/chats/{chat_id}?workspace_id=...
func HandleAIRIDeleteChat(pool *AccountPool) http.HandlerFunc {
	return airiChatScoped(pool, func(w http.ResponseWriter, r *http.Request, t *airiTarget, chatID string) {
		payload := t.payload()
		payload["thread_id"] = chatID
		airiForward(w, airiInvoke(HandleChatDelete(nil), r, payload))
	})
}

// HandleAIRIStopChat aborts an in-flight turn.
// POST /v1/airi/chats/{chat_id}/stop
func HandleAIRIStopChat(pool *AccountPool) http.HandlerFunc {
	return airiChatScoped(pool, func(w http.ResponseWriter, r *http.Request, t *airiTarget, chatID string) {
		payload := t.payload()
		payload["thread_id"] = chatID
		c := airiInvoke(HandleChatStop(nil), r, payload)
		if c.ok() {
			if prev := airiTasks.latestForChat(chatID); prev != nil {
				airiTasks.update(prev, func(x *airiTask) {
					if x.Status == airiStatusQueued || x.Status == airiStatusRunning {
						x.Status = airiStatusStopped
						x.FinishedAt = time.Now().UnixMilli()
					}
				})
			}
		}
		airiForward(w, c)
	})
}
