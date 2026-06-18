package proxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// chat.go proxies the private Notion AI chat protocol (runInferenceTranscript +
// the thread/agent listing endpoints) using each workspace account's token_v2
// cookie. It powers the dashboard "Чат" tab: pick a workspace, pick an agent
// (the built-in assistant or a custom agent), start a new chat or continue an
// existing thread, and stream the assistant reply.

// notionChatRequest issues a POST to a private Notion API endpoint authenticated
// with the account's token_v2 cookie, mirroring the headers the real web client
// sends. accept negotiates the response type ("application/x-ndjson" for the
// streaming runInferenceTranscript endpoint, "application/json" otherwise).
func notionChatRequest(tokenV2, userID, spaceID, path string, body []byte, accept string, timeout time.Duration) (*http.Response, error) {
	client := getChromeHTTPClient(timeout)
	req, err := http.NewRequest("POST", NotionAPIBase+"/"+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if accept == "" {
		accept = "application/json"
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", accept)
	req.Header.Set("Cookie", "token_v2="+tokenV2)
	if AppConfig != nil {
		req.Header.Set("User-Agent", AppConfig.Browser.UserAgent)
	}
	if userID != "" {
		req.Header.Set("x-notion-active-user-header", userID)
	}
	if spaceID != "" {
		req.Header.Set("x-notion-space-id", spaceID)
	}
	req.Header.Set("notion-client-version", DefaultClientVersion)
	req.Header.Set("notion-audit-log-platform", "web")
	return client.Do(req)
}

// chatAuthOK enforces POST + dashboard session (when a password is configured).
func chatAuthOK(auth *DashboardAuth, w http.ResponseWriter, r *http.Request) bool {
	if r.Method != "POST" {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return false
	}
	if auth != nil && auth.HasAdminPassword() && !auth.ValidateSession(r) {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return false
	}
	return true
}

func chatAPITimeout() time.Duration {
	if AppConfig != nil {
		if d := AppConfig.APITimeoutDuration(); d > 0 {
			return d
		}
	}
	return 30 * time.Second
}

// ---- Agents ----

type chatAgent struct {
	ID   string `json:"id"` // "default" or a workflowId
	Name string `json:"name"`
	Icon string `json:"icon,omitempty"`
	Kind string `json:"kind"` // "default" | "custom"
}

// HandleChatAgents returns the built-in assistant plus every custom agent the
// account can see in the given space.
func HandleChatAgents(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !chatAuthOK(auth, w, r) {
			return
		}
		var body struct {
			TokenV2 string `json:"token_v2"`
			UserID  string `json:"user_id"`
			SpaceID string `json:"space_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		body.TokenV2 = strings.TrimSpace(body.TokenV2)
		body.SpaceID = strings.TrimSpace(body.SpaceID)
		if body.TokenV2 == "" || body.SpaceID == "" {
			http.Error(w, `{"error":"token_v2 and space_id are required"}`, http.StatusBadRequest)
			return
		}
		agents := []chatAgent{ {ID: "default", Name: "Обычный агент", Kind: "default"} }
		if custom, err := fetchCustomAgents(body.TokenV2, body.UserID, body.SpaceID); err != nil {
			log.Printf("[chat] fetch custom agents failed: %v", err)
		} else {
			agents = append(agents, custom...)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"agents": agents})
	}
}

func transcriptsRequestBody(spaceID string) []byte {
	b, _ := json.Marshal(map[string]interface{}{
		"threadParentPointer":   map[string]string{"table": "space", "id": spaceID, "spaceId": spaceID},
		"includeWorkflowThreads": true,
		"includeWriterChats":     false,
	})
	return b
}

func fetchCustomAgents(tokenV2, userID, spaceID string) ([]chatAgent, error) {
	resp, err := notionChatRequest(tokenV2, userID, spaceID, "getInferenceTranscriptsForUser", transcriptsRequestBody(spaceID), "application/json", chatAPITimeout())
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("getInferenceTranscriptsForUser %d: %s", resp.StatusCode, truncate(string(data), 200))
	}
	var parsed struct {
		RecordMap struct {
			Workflow map[string]struct {
				Value struct {
					Value struct {
						ID   string `json:"id"`
						Data struct {
							Icon string `json:"icon"`
							Name string `json:"name"`
						} `json:"data"`
					} `json:"value"`
				} `json:"value"`
			} `json:"workflow"`
		} `json:"recordMap"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, err
	}
	out := make([]chatAgent, 0, len(parsed.RecordMap.Workflow))
	for _, wf := range parsed.RecordMap.Workflow {
		id := wf.Value.Value.ID
		if id == "" {
			continue
		}
		name := wf.Value.Value.Data.Name
		if name == "" {
			name = "Агент"
		}
		out = append(out, chatAgent{ID: id, Name: name, Icon: wf.Value.Value.Data.Icon, Kind: "custom"})
	}
	return out, nil
}

// ---- Models ----

// HandleChatModels proxies getAvailableModels for the built-in assistant model
// picker. It returns the codename, the human label and the display group so the
// dashboard can show e.g. "Opus 4.8" and send the codename ambrosia-tart-high.
func HandleChatModels(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !chatAuthOK(auth, w, r) {
			return
		}
		var body struct {
			TokenV2 string `json:"token_v2"`
			UserID  string `json:"user_id"`
			SpaceID string `json:"space_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		body.TokenV2 = strings.TrimSpace(body.TokenV2)
		body.SpaceID = strings.TrimSpace(body.SpaceID)
		if body.TokenV2 == "" || body.SpaceID == "" {
			http.Error(w, `{"error":"token_v2 and space_id are required"}`, http.StatusBadRequest)
			return
		}
		reqBody, _ := json.Marshal(map[string]string{"spaceId": body.SpaceID})
		resp, err := notionChatRequest(body.TokenV2, body.UserID, body.SpaceID, "getAvailableModels", reqBody, "application/json", chatAPITimeout())
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("notion %d", resp.StatusCode)})
			return
		}
		var parsed struct {
			Models []struct {
				Model        string `json:"model"`
				ModelMessage string `json:"modelMessage"`
				ModelFamily  string `json:"modelFamily"`
				DisplayGroup string `json:"displayGroup"`
				IsDisabled   bool   `json:"isDisabled"`
			} `json:"models"`
		}
		json.Unmarshal(data, &parsed)
		type outModel struct {
			ID       string `json:"id"`
			Label    string `json:"label"`
			Family   string `json:"family"`
			Group    string `json:"group"`
			Disabled bool   `json:"disabled"`
		}
		out := make([]outModel, 0, len(parsed.Models))
		for _, m := range parsed.Models {
			if m.Model == "" {
				continue
			}
			label := m.ModelMessage
			if label == "" {
				label = m.Model
			}
			out = append(out, outModel{ID: m.Model, Label: label, Family: m.ModelFamily, Group: m.DisplayGroup, Disabled: m.IsDisabled})
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"models": out})
	}
}

// ---- Threads ----

type chatThread struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
	Type      string `json:"type"`
}

// HandleChatThreads lists the account's recent chat threads in a space.
func HandleChatThreads(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !chatAuthOK(auth, w, r) {
			return
		}
		var body struct {
			TokenV2 string `json:"token_v2"`
			UserID  string `json:"user_id"`
			SpaceID string `json:"space_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		body.TokenV2 = strings.TrimSpace(body.TokenV2)
		body.SpaceID = strings.TrimSpace(body.SpaceID)
		if body.TokenV2 == "" || body.SpaceID == "" {
			http.Error(w, `{"error":"token_v2 and space_id are required"}`, http.StatusBadRequest)
			return
		}
		resp, err := notionChatRequest(body.TokenV2, body.UserID, body.SpaceID, "getInferenceTranscriptsForUser", transcriptsRequestBody(body.SpaceID), "application/json", chatAPITimeout())
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("notion %d", resp.StatusCode)})
			return
		}
		var parsed struct {
			Transcripts []chatThread `json:"transcripts"`
		}
		json.Unmarshal(data, &parsed)
		json.NewEncoder(w).Encode(map[string]interface{}{"threads": parsed.Transcripts})
	}
}

// HandleChatDelete soft-deletes a chat thread (sets thread.alive=false) using the
// same saveTransactionsFanout transaction the web client sends for
// "assistantChatHistoryItem.deleteInferenceChatTranscript".
func HandleChatDelete(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !chatAuthOK(auth, w, r) {
			return
		}
		var body struct {
			TokenV2  string `json:"token_v2"`
			UserID   string `json:"user_id"`
			SpaceID  string `json:"space_id"`
			ThreadID string `json:"thread_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		body.TokenV2 = strings.TrimSpace(body.TokenV2)
		body.SpaceID = strings.TrimSpace(body.SpaceID)
		body.ThreadID = strings.TrimSpace(body.ThreadID)
		if body.TokenV2 == "" || body.SpaceID == "" || body.ThreadID == "" {
			http.Error(w, `{"error":"token_v2, space_id and thread_id are required"}`, http.StatusBadRequest)
			return
		}
		op := map[string]interface{}{
			"pointer": map[string]string{"table": "thread", "id": body.ThreadID, "spaceId": body.SpaceID},
			"path":    []string{},
			"command": "update",
			"args": map[string]interface{}{
				"alive":                              false,
				"current_inference_id":               nil,
				"current_inference_lease_expiration": nil,
			},
		}
		tx := map[string]interface{}{
			"id":         generateUUIDv4(),
			"spaceId":    body.SpaceID,
			"debug":      map[string]string{"userAction": "assistantChatHistoryItem.deleteInferenceChatTranscript"},
			"operations": []interface{}{op},
		}
		reqBody, _ := json.Marshal(map[string]interface{}{
			"requestId":    generateUUIDv4(),
			"transactions": []interface{}{tx},
		})
		resp, err := notionChatRequest(body.TokenV2, body.UserID, body.SpaceID, "saveTransactionsFanout", reqBody, "application/json", chatAPITimeout())
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		defer resp.Body.Close()
		io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("notion %d", resp.StatusCode)})
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})
	}
}

// ---- History ----

// chatStep is a single visible reasoning/tool step of an assistant turn.
type chatStep struct {
	Kind   string `json:"kind"`             // "thought" | "tool"
	Text   string `json:"text"`             // thought text, or tool label
	Tool   string `json:"tool,omitempty"`   // display label, e.g. "GitHub / get_me"
	Server string `json:"server,omitempty"` // icon hint, e.g. "github"
	Input  string `json:"input,omitempty"`  // pretty-printed input arguments
	Result string `json:"result,omitempty"` // pretty-printed tool result
}

// chatHistMsg is one rendered message of a past conversation.
type chatHistMsg struct {
	Role  string     `json:"role"` // "user" | "assistant"
	Text  string     `json:"text"`
	Steps []chatStep `json:"steps,omitempty"`
}

// ---- tool-call presentation helpers ----

// serverLabel turns an MCP connector key into a display name ("github" -> "GitHub").
func serverLabel(s string) string {
	switch strings.ToLower(s) {
	case "github":
		return "GitHub"
	case "":
		return "MCP"
	default:
		return strings.ToUpper(s[:1]) + s[1:]
	}
}

func isMeaningful(raw json.RawMessage) bool {
	s := strings.TrimSpace(string(raw))
	return s != "" && s != "null" && s != "{}" && s != "[]"
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n] + "\n… (обрезано)"
	}
	return s
}

func prettyJSON(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var v interface{}
	if json.Unmarshal(raw, &v) != nil {
		return clip(strings.TrimSpace(string(raw)), 4000)
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return clip(strings.TrimSpace(string(raw)), 4000)
	}
	return clip(string(b), 4000)
}

func prettyMaybeJSON(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	var v interface{}
	if json.Unmarshal([]byte(s), &v) == nil {
		if b, err := json.MarshalIndent(v, "", "  "); err == nil {
			return clip(string(b), 4000)
		}
	}
	return clip(s, 4000)
}

// describeToolCall turns a callFunction input ({function, args}) into a human
// label, an icon hint (connector key) and the pretty-printed input arguments.
// For MCP connectors it digs into args.toolName / args.toolArguments so the
// label reads e.g. "GitHub / get_me" instead of the wrapper "runTool".
func describeToolCall(fn string, args json.RawMessage) (label, server, input string) {
	fn = strings.TrimSpace(fn)
	short := fn
	for _, p := range []string{"connections.", "adminUserConnections.", "userConnections."} {
		if strings.HasPrefix(short, p) {
			short = strings.TrimPrefix(short, p)
			break
		}
	}
	module := short
	method := ""
	if i := strings.Index(short, "."); i >= 0 {
		module = short[:i]
		method = short[i+1:]
	}
	if strings.HasPrefix(module, "mcpServer") {
		srv := strings.TrimPrefix(module, "mcpServer")
		srv = strings.TrimPrefix(srv, "_")
		server = strings.ToLower(srv)
		var a struct {
			ToolName      string          `json:"toolName"`
			ToolArguments json.RawMessage `json:"toolArguments"`
		}
		_ = json.Unmarshal(args, &a)
		if method == "listTools" {
			return serverLabel(server) + ": список инструментов", server, ""
		}
		tn := a.ToolName
		if tn == "" {
			tn = method
		}
		label = serverLabel(server) + " / " + tn
		if isMeaningful(a.ToolArguments) {
			input = prettyJSON(a.ToolArguments)
		}
		return label, server, input
	}
	label = short
	if isMeaningful(args) {
		input = prettyJSON(args)
	}
	return label, "", input
}

// resultString prefers the structured result object, falling back to the raw
// output string (which is itself often JSON).
func resultString(output, result json.RawMessage) string {
	if isMeaningful(result) {
		return prettyJSON(result)
	}
	if len(output) > 0 && strings.TrimSpace(string(output)) != "null" {
		var s string
		if json.Unmarshal(output, &s) == nil {
			return prettyMaybeJSON(s)
		}
		return prettyJSON(output)
	}
	return ""
}

// parseToolResultStep folds one agent-tool-result step into a tool chatStep,
// pulling label/input from step.input.function and result from output/result.
func parseToolResultStep(s tmStep) chatStep {
	inputRaw := s.Input
	outputRaw := s.Output
	resultRaw := s.Result
	toolName := s.ToolName
	if len(inputRaw) == 0 && len(s.Value) > 0 {
		var v struct {
			ToolName string          `json:"toolName"`
			Input    json.RawMessage `json:"input"`
			Output   json.RawMessage `json:"output"`
			Result   json.RawMessage `json:"result"`
		}
		if json.Unmarshal(s.Value, &v) == nil {
			inputRaw = v.Input
			outputRaw = v.Output
			resultRaw = v.Result
			toolName = v.ToolName
		}
	}
	var in struct {
		Function string          `json:"function"`
		Args     json.RawMessage `json:"args"`
	}
	_ = json.Unmarshal(inputRaw, &in)
	label, server, input := describeToolCall(in.Function, in.Args)
	if label == "" {
		if toolName != "" {
			label = toolName
		} else {
			label = "Инструмент"
		}
	}
	return chatStep{Kind: "tool", Tool: label, Text: label, Server: server, Input: input, Result: resultString(outputRaw, resultRaw)}
}

// syncRecordValues fetches one or more records by pointer through the private
// syncRecordValuesSpaceInitial endpoint. version -1 forces the full record.
func syncRecordValues(tokenV2, userID, spaceID string, pointers []map[string]string) ([]byte, error) {
	reqs := make([]map[string]interface{}, 0, len(pointers))
	for _, p := range pointers {
		reqs = append(reqs, map[string]interface{}{"pointer": p, "version": -1})
	}
	body, _ := json.Marshal(map[string]interface{}{
		"requests":     reqs,
		"spacePointer": map[string]string{"table": "space", "id": spaceID},
	})
	resp, err := notionChatRequest(tokenV2, userID, spaceID, "syncRecordValuesSpaceInitial", body, "application/json", chatAPITimeout())
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("syncRecordValues %d: %s", resp.StatusCode, truncate(string(data), 200))
	}
	return data, nil
}

// HandleChatHistory rebuilds the full message history of a single thread.
func HandleChatHistory(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !chatAuthOK(auth, w, r) {
			return
		}
		var body struct {
			TokenV2  string `json:"token_v2"`
			UserID   string `json:"user_id"`
			SpaceID  string `json:"space_id"`
			ThreadID string `json:"thread_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		body.TokenV2 = strings.TrimSpace(body.TokenV2)
		body.SpaceID = strings.TrimSpace(body.SpaceID)
		body.ThreadID = strings.TrimSpace(body.ThreadID)
		if body.TokenV2 == "" || body.SpaceID == "" || body.ThreadID == "" {
			http.Error(w, `{"error":"token_v2, space_id and thread_id are required"}`, http.StatusBadRequest)
			return
		}

		threadData, err := syncRecordValues(body.TokenV2, body.UserID, body.SpaceID, []map[string]string{
			{"table": "thread", "id": body.ThreadID, "spaceId": body.SpaceID},
		})
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		var tr struct {
			RecordMap struct {
				Thread map[string]struct {
					Value struct {
						Value struct {
							Messages []string `json:"messages"`
						} `json:"value"`
					} `json:"value"`
				} `json:"thread"`
			} `json:"recordMap"`
		}
		json.Unmarshal(threadData, &tr)
		var order []string
		if t, ok := tr.RecordMap.Thread[body.ThreadID]; ok {
			order = t.Value.Value.Messages
		}
		if len(order) == 0 {
			json.NewEncoder(w).Encode(map[string]interface{}{"messages": []chatHistMsg{}})
			return
		}

		pointers := make([]map[string]string, 0, len(order))
		for _, id := range order {
			pointers = append(pointers, map[string]string{"table": "thread_message", "id": id, "spaceId": body.SpaceID})
		}
		msgData, err := syncRecordValues(body.TokenV2, body.UserID, body.SpaceID, pointers)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		var wrap struct {
			RecordMap recordMapShape `json:"recordMap"`
		}
		json.Unmarshal(msgData, &wrap)

		messages := buildHistory(wrap.RecordMap, order)
		json.NewEncoder(w).Encode(map[string]interface{}{"messages": messages})
	}
}

// buildHistory walks the thread's messages[] in canonical order.
func buildHistory(rm recordMapShape, order []string) []chatHistMsg {
	out := []chatHistMsg{}
	var cur *chatHistMsg
	flush := func() {
		if cur != nil {
			out = append(out, *cur)
			cur = nil
		}
	}
	for _, id := range order {
		rec, ok := rm.ThreadMessage[id]
		if !ok {
			continue
		}
		step := rec.Value.Value.Step
		switch step.Type {
		case "user":
			flush()
			out = append(out, chatHistMsg{Role: "user", Text: parseUserText(step.Value)})
		case "agent-inference":
			st, t := parseInferenceParts(step.Value)
			if cur == nil {
				cur = &chatHistMsg{Role: "assistant"}
			}
			cur.Steps = append(cur.Steps, st...)
			cur.Text += t
		case "agent-tool-result":
			if cur == nil {
				cur = &chatHistMsg{Role: "assistant"}
			}
			cur.Steps = append(cur.Steps, parseToolResultStep(step))
		}
	}
	flush()
	return out
}

// ---- Send ----

// chatSendBody is the shared request shape for both the synchronous send and
// the streaming send. Model is only honoured for the built-in assistant.
type chatSendBody struct {
	TokenV2       string `json:"token_v2"`
	UserID        string `json:"user_id"`
	UserName      string `json:"user_name"`
	UserEmail     string `json:"user_email"`
	SpaceID       string `json:"space_id"`
	SpaceViewID   string `json:"space_view_id"`
	SpaceName     string `json:"space_name"`
	Timezone      string `json:"timezone"`
	Agent         string `json:"agent"`
	Model         string `json:"model"`
	ContextPageID string `json:"context_page_id"`
	ThreadID      string `json:"thread_id"`
	Message       string `json:"message"`
}

// buildChatConfig returns the transcript config block. model is set only for the
// built-in assistant (modelFromUser=true); custom agents carry their own model.
func buildChatConfig(isCustom bool, workflowID string, model string) map[string]interface{} {
	cfg := map[string]interface{}{
		"type":                                 "workflow",
		"enableAgentAutomations":               true,
		"enableAgentIntegrations":              true,
		"enableCustomAgents":                   true,
		"enableExperimentalIntegrations":       false,
		"enableAgentDiffs":                     true,
		"enableCsvAttachmentSupport":           true,
		"showDatabaseAgentsDiscoverability":    true,
		"enableAgentThreadTools":               false,
		"enableCrdtOperations":                 false,
		"enableAgentCardCustomization":         true,
		"enableSystemPromptAsPage":             false,
		"enableUserSessionContext":             false,
		"enableLargeToolResultComputerOffload": false,
		"enableScriptAgentAdvanced":            false,
		"enableScriptAgent":                    true,
		"enableScriptAgentSearchConnectorsInCustomAgent": false,
		"enableScriptAgentGoogleDriveInCustomAgent":      false,
		"enableScriptAgentGoogleDriveOAuthInCustomAgent": false,
		"enableScriptAgentSlack":              true,
		"enableScriptAgentMcpServers":         false,
		"enableScriptAgentGtm":                false,
		"enableComputer":                      true,
		"enableCreateAndRunThread":            true,
		"enableSoftwareFactoryPage":           false,
		"enableAgentGenerateImage":            true,
		"enableQueryCalendar":                 false,
		"enableQueryMail":                     false,
		"enableMailExplicitToolCalls":         true,
		"enableMailNotificationPreferences":   false,
		"enableMailAgentMultiProviderSupport": false,
		"useRulePrioritization":               true,
		"availableConnectors":                 []interface{}{},
		"searchScopes":                        []map[string]string{ {"type": "everything"} },
		"useWebSearch":                        true,
		"isHipaa":                             false,
		"internetAccess":                      false,
		"useReadOnlyMode":                     false,
		"writerMode":                          false,
		"modelFromUser":                       !isCustom,
		"isCustomAgent":                       isCustom,
		"isCustomAgentBuilder":                false,
		"isAgentResearchRequest":              false,
		"useCustomAgentDraft":                 isCustom,
		"use_draft_actor_pointer":             false,
		"enableUpdatePageAutofixer":           true,
		"enableMarkdownVNext":                 false,
		"enableEmbedBlocks":                   true,
		"updatePageStaleViewGuardEnabled":     false,
		"enableUpdatePageOrderUpdates":        true,
		"enableAgentSupportPropertyReorder":   true,
		"enableAgentAskSurvey":                true,
		"databaseAgentConfigMode":             false,
		"isOnboardingAgent":                   false,
		"isMobile":                            false,
	}
	if !isCustom && strings.TrimSpace(model) != "" {
		cfg["model"] = model
	}
	if isCustom && workflowID != "" {
		cfg["workflowId"] = workflowID
	}
	return cfg
}

// buildSendPayload constructs the runInferenceTranscript request body for a chat
// turn and returns it together with the (possibly newly minted) thread id.
func buildSendPayload(body chatSendBody) (map[string]interface{}, string) {
	isCustom := body.Agent != "" && body.Agent != "default"
	workflowID := ""
	if isCustom {
		workflowID = body.Agent
	}
	tz := body.Timezone
	if tz == "" {
		tz = "UTC"
	}
	configMsg := map[string]interface{}{
		"id":    generateUUIDv4(),
		"type":  "config",
		"value": buildChatConfig(isCustom, workflowID, body.Model),
	}
	ctxVal := map[string]interface{}{
		"timezone":        tz,
		"userName":        body.UserName,
		"userId":          body.UserID,
		"userEmail":       body.UserEmail,
		"spaceName":       body.SpaceName,
		"spaceId":         body.SpaceID,
		"spaceViewId":     body.SpaceViewID,
		"currentDatetime": time.Now().Format("2006-01-02T15:04:05.000-07:00"),
	}
	if isCustom {
		ctxVal["surface"] = "custom_agent"
		ctxVal["workflowId"] = workflowID
		if body.ContextPageID != "" {
			ctxVal["context_page_id"] = body.ContextPageID
		}
	} else {
		ctxVal["surface"] = "ai_module"
	}
	contextMsg := map[string]interface{}{
		"id":    generateUUIDv4(),
		"type":  "context",
		"value": ctxVal,
	}
	userMsg := map[string]interface{}{
		"id":        generateUUIDv4(),
		"type":      "user",
		"value":     [][]string{ {body.Message} },
		"userId":    body.UserID,
		"createdAt": time.Now().UnixMilli(),
	}
	newThread := strings.TrimSpace(body.ThreadID) == ""
	threadID := strings.TrimSpace(body.ThreadID)
	if newThread {
		threadID = generateUUIDv4()
	}
	createdSource := "ai_module"
	if isCustom {
		createdSource = "custom_agent"
	}
	payload := map[string]interface{}{
		"traceId":                       generateUUIDv4(),
		"spaceId":                       body.SpaceID,
		"transcript":                    []interface{}{configMsg, contextMsg, userMsg},
		"threadId":                      threadID,
		"createThread":                  newThread,
		"debugOverrides":                map[string]interface{}{},
		"generateTitle":                 true,
		"saveAllThreadOperations":       true,
		"setUnreadState":                true,
		"createdSource":                 createdSource,
		"threadType":                    "workflow",
		"isPartialTranscript":           !newThread,
		"asPatchResponse":               true,
		"patchResponseVersion":          2,
		"isUserInAnySalesAssistedSpace": false,
		"isSpaceSalesAssisted":          false,
	}
	if newThread {
		tp := map[string]string{"spaceId": body.SpaceID}
		if isCustom {
			tp["table"] = "workflow"
			tp["id"] = workflowID
		} else {
			tp["table"] = "space"
			tp["id"] = body.SpaceID
		}
		payload["threadParentPointer"] = tp
	}
	return payload, threadID
}

// HandleChatSend runs one chat turn synchronously (no live status).
func HandleChatSend(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !chatAuthOK(auth, w, r) {
			return
		}
		var body chatSendBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		body.TokenV2 = strings.TrimSpace(body.TokenV2)
		body.SpaceID = strings.TrimSpace(body.SpaceID)
		body.Message = strings.TrimSpace(body.Message)
		if body.TokenV2 == "" || body.SpaceID == "" || body.Message == "" {
			http.Error(w, `{"error":"token_v2, space_id and message are required"}`, http.StatusBadRequest)
			return
		}
		payload, threadID := buildSendPayload(body)
		reqBody, _ := json.Marshal(payload)
		resp, err := notionChatRequest(body.TokenV2, body.UserID, body.SpaceID, "runInferenceTranscript", reqBody, "application/x-ndjson", 180*time.Second)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			log.Printf("[chat] runInferenceTranscript %d: %s", resp.StatusCode, truncate(string(raw), 300))
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("notion error %d: %s", resp.StatusCode, truncate(string(raw), 200))})
			return
		}
		text, title, steps := parseInferenceStream(raw)
		if strings.TrimSpace(text) == "" {
			text = "(агент не вернул текстового ответа)"
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"thread_id": threadID,
			"title":     title,
			"text":      text,
			"steps":     steps,
		})
	}
}

// ---- Streaming send (live agent state) ----

// sMeta tracks the type of each entry in the patch stream's state array ("s")
// so content deltas (op "x") can be attributed to the right kind of step.
type sMeta struct {
	typ       string
	tool      string
	server    string
	label     string
	input     string
	result    string
	thinking  string
	partTypes []string
}

func metaFromItem(raw json.RawMessage) sMeta {
	var it struct {
		Type     string          `json:"type"`
		ToolName string          `json:"toolName"`
		Input    json.RawMessage `json:"input"`
		Output   json.RawMessage `json:"output"`
		Result   json.RawMessage `json:"result"`
		Value    []struct {
			Type    string `json:"type"`
			Content string `json:"content"`
		} `json:"value"`
	}
	m := sMeta{}
	if json.Unmarshal(raw, &it) != nil {
		return m
	}
	m.typ = it.Type
	if len(it.Input) > 0 || it.ToolName != "" {
		var in struct {
			Function string          `json:"function"`
			Args     json.RawMessage `json:"args"`
		}
		_ = json.Unmarshal(it.Input, &in)
		label, server, input := describeToolCall(in.Function, in.Args)
		if label == "" {
			label = it.ToolName
		}
		m.tool = in.Function
		m.label = label
		m.server = server
		m.input = input
	}
	m.result = resultString(it.Output, it.Result)
	for _, p := range it.Value {
		m.partTypes = append(m.partTypes, p.Type)
		if p.Type == "thinking" && m.thinking == "" {
			m.thinking = p.Content
		}
	}
	return m
}

// parseContentPath parses "/s/<idx>/value/<part>/content" into idx + part.
func parseContentPath(p string) (int, int, bool) {
	if !strings.HasPrefix(p, "/s/") || !strings.HasSuffix(p, "/content") {
		return 0, 0, false
	}
	parts := strings.Split(strings.Trim(p, "/"), "/")
	if len(parts) < 5 || parts[2] != "value" {
		return 0, 0, false
	}
	idx, e1 := strconv.Atoi(parts[1])
	pt, e2 := strconv.Atoi(parts[3])
	if e1 != nil || e2 != nil {
		return 0, 0, false
	}
	return idx, pt, true
}

// processStreamLine parses one ndjson line of the patch stream and emits a
// best-effort "status" event describing what the agent is doing right now.
func processStreamLine(line []byte, sItems *[]sMeta, emit func(map[string]interface{})) {
	var probe struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(line, &probe) != nil {
		return
	}
	switch probe.Type {
	case "patch-start":
		var ps struct {
			Data struct {
				S []json.RawMessage `json:"s"`
			} `json:"data"`
		}
		if json.Unmarshal(line, &ps) == nil {
			for _, raw := range ps.Data.S {
				*sItems = append(*sItems, metaFromItem(raw))
			}
		}
	case "patch":
		var p struct {
			V []struct {
				O string          `json:"o"`
				P string          `json:"p"`
				V json.RawMessage `json:"v"`
			} `json:"v"`
		}
		if json.Unmarshal(line, &p) != nil {
			return
		}
		for _, op := range p.V {
