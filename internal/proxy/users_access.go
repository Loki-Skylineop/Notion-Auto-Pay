package proxy

// Authorization layer on top of the user registry.
//
// Handlers themselves stay untouched: everything is enforced by wrapping the
// existing http.HandlerFunc values in cmd/notion-manager/main.go.
//
//	RequireAdmin  — admin-only endpoints (adding accounts, paying, register,
//	                creating/deleting workspaces, settings, user management).
//	AdminOnPost   — GET stays readable for everyone, writes are admin-only.
//	Scoped        — request must reference an account/workspace the caller owns.
//	FilterWorkspaces — trims /admin/workspaces down to the caller's own
//	                   accounts plus the spaces an admin granted them.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
)

// Caller identifies who is behind the current request.
type Caller struct {
	Username string
	Role     string
	// AuthOff means the dashboard has no password and no users at all, i.e.
	// the original "open dashboard" mode. Everything is permitted then.
	AuthOff bool
	// LoggedIn is false when the session cookie is missing or expired.
	LoggedIn bool
}

// IsAdmin reports full dashboard rights.
func (c Caller) IsAdmin() bool { return c.AuthOff || c.Role == RoleAdmin }

// AccessGuard couples the session store, the user registry and the account
// pool so it can answer "may this caller touch this account/space?".
type AccessGuard struct {
	auth  *DashboardAuth
	store *UserStore
	pool  *AccountPool

	// spaceOwners caches space_id -> owning account email. Filled from the
	// /admin/workspaces discovery responses that flow through this guard, so
	// ownership checks need no extra network calls.
	mu          sync.RWMutex
	spaceOwners map[string]string
}

// NewAccessGuard wires the guard. store may be nil, in which case only the
// legacy single-admin mode exists.
func NewAccessGuard(auth *DashboardAuth, store *UserStore, pool *AccountPool) *AccessGuard {
	return &AccessGuard{
		auth:        auth,
		store:       store,
		pool:        pool,
		spaceOwners: map[string]string{},
	}
}

// Store exposes the registry for the user-management handlers.
func (g *AccessGuard) Store() *UserStore { return g.store }

// Caller resolves the session behind a request.
func (g *AccessGuard) Caller(r *http.Request) Caller {
	if g == nil || g.auth == nil {
		return Caller{AuthOff: true}
	}
	return g.auth.CallerFor(r)
}

// --- ownership bookkeeping ---

func (g *AccessGuard) rememberSpaceOwners(list []*AccountWorkspaces) {
	if len(list) == 0 {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, aw := range list {
		if aw == nil {
			continue
		}
		email := normalizeEmail(aw.UserEmail)
		if email == "" {
			continue
		}
		for _, sp := range aw.Spaces {
			if id := strings.TrimSpace(sp.SpaceID); id != "" {
				g.spaceOwners[id] = email
			}
		}
	}
}

func (g *AccessGuard) spaceOwner(spaceID string) string {
	g.mu.RLock()
	email := g.spaceOwners[strings.TrimSpace(spaceID)]
	g.mu.RUnlock()
	if email != "" {
		return email
	}
	// Fall back to the account's primary space recorded in accounts/*.json.
	if g.pool != nil {
		g.pool.mu.RLock()
		defer g.pool.mu.RUnlock()
		for _, acc := range g.pool.accounts {
			if strings.EqualFold(strings.TrimSpace(acc.SpaceID), strings.TrimSpace(spaceID)) {
				return normalizeEmail(acc.UserEmail)
			}
		}
	}
	return ""
}

// emailForToken resolves a token_v2 to the pool account's email.
func (g *AccessGuard) emailForToken(token string) (string, bool) {
	token = strings.TrimSpace(token)
	if token == "" || g.pool == nil {
		return "", false
	}
	g.pool.mu.RLock()
	defer g.pool.mu.RUnlock()
	for _, acc := range g.pool.accounts {
		if strings.TrimSpace(acc.TokenV2) == token {
			return normalizeEmail(acc.UserEmail), true
		}
	}
	return "", false
}

// allowed collects both permission sets for a caller once per request.
type allowance struct {
	emails       map[string]bool
	spaces       map[string]bool
	spaceEmails  map[string]string
	grantedMails map[string]bool
}

func (g *AccessGuard) allowanceFor(c Caller) allowance {
	a := allowance{
		emails:       map[string]bool{},
		spaces:       map[string]bool{},
		spaceEmails:  map[string]string{},
		grantedMails: map[string]bool{},
	}
	if g.store == nil || c.Username == "" {
		return a
	}
	a.emails = g.store.AllowedAccounts(c.Username)
	a.spaces = g.store.AllowedSpaces(c.Username)
	a.spaceEmails = g.store.GrantedSpaceEmails(c.Username)
	for _, email := range a.spaceEmails {
		if email != "" {
			a.grantedMails[email] = true
		}
	}
	return a
}

// canEmail reports whether the caller may act on a pool account.
func (g *AccessGuard) canEmail(a allowance, email string) bool {
	n := normalizeEmail(email)
	if n == "" {
		return true // nothing to authorize
	}
	return a.emails[n] || a.grantedMails[n]
}

// canSpace reports whether the caller may act on a workspace.
func (g *AccessGuard) canSpace(a allowance, spaceID string) bool {
	id := strings.TrimSpace(spaceID)
	if id == "" {
		return true
	}
	if a.spaces[id] {
		return true
	}
	owner := g.spaceOwner(id)
	if owner != "" && a.emails[owner] {
		return true
	}
	// Unknown space on an owned token is allowed: the token itself is the
	// authorization, Notion rejects spaces the token cannot see.
	return owner == ""
}

// --- middleware ---

func denyJSON(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "message": msg})
}

// RequireAdmin rejects anything but an authenticated admin session.
func (g *AccessGuard) RequireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c := g.Caller(r)
		if c.AuthOff {
			next(w, r)
			return
		}
		if !c.LoggedIn {
			denyJSON(w, http.StatusUnauthorized, "unauthorized", "Требуется вход в админку")
			return
		}
		if !c.IsAdmin() {
			denyJSON(w, http.StatusForbidden, "forbidden", "Действие доступно только администратору")
			return
		}
		next(w, r)
	}
}

// AdminOnWrite keeps GET/HEAD open to any logged-in user and restricts the
// mutating verbs to admins. Used for endpoints like /admin/autopay where the
// pay tab must stay readable but not editable.
func (g *AccessGuard) AdminOnWrite(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next(w, r)
			return
		}
		g.RequireAdmin(next)(w, r)
	}
}

// scopeRequest is the subset of any admin payload that identifies a target.
type scopeRequest struct {
	TokenV2  string `json:"token_v2"`
	Email    string `json:"email"`
	SpaceID  string `json:"space_id"`
	SpaceID2 string `json:"spaceId"`
}

// Scoped lets any logged-in user through but only for accounts and workspaces
// that belong to them. Admins are unaffected.
func (g *AccessGuard) Scoped(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c := g.Caller(r)
		if c.AuthOff || c.IsAdmin() {
			next(w, r)
			return
		}
		if !c.LoggedIn {
			denyJSON(w, http.StatusUnauthorized, "unauthorized", "Требуется вход")
			return
		}

		var sc scopeRequest
		// Query parameters first (GET endpoints), then the JSON body. The body
		// is restored afterwards so the real handler still reads it.
		q := r.URL.Query()
		sc.Email = q.Get("email")
		sc.SpaceID = q.Get("space_id")
		sc.TokenV2 = q.Get("token_v2")

		if r.Body != nil && r.Method != http.MethodGet {
			buf, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
			_ = r.Body.Close()
			if err != nil {
				denyJSON(w, http.StatusBadRequest, "bad_request", "Не удалось прочитать запрос")
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(buf))
			if len(buf) > 0 && strings.Contains(r.Header.Get("Content-Type"), "json") {
				var body scopeRequest
				if json.Unmarshal(buf, &body) == nil {
					if body.TokenV2 != "" {
						sc.TokenV2 = body.TokenV2
					}
					if body.Email != "" {
						sc.Email = body.Email
					}
					if body.SpaceID != "" {
						sc.SpaceID = body.SpaceID
					}
					if body.SpaceID2 != "" && sc.SpaceID == "" {
						sc.SpaceID = body.SpaceID2
					}
				}
			}
		}

		a := g.allowanceFor(c)

		if sc.TokenV2 != "" {
			email, known := g.emailForToken(sc.TokenV2)
			if !known {
				denyJSON(w, http.StatusForbidden, "forbidden", "Аккаунт не найден в пуле или не выдан вам")
				return
			}
			if !g.canEmail(a, email) {
				denyJSON(w, http.StatusForbidden, "forbidden", "Этот аккаунт вам не выдан")
				return
			}
			// A granted-but-not-owned account is usable only inside the granted
			// workspace, never across the whole account.
			if !a.emails[email] && sc.SpaceID != "" && !a.spaces[strings.TrimSpace(sc.SpaceID)] {
				denyJSON(w, http.StatusForbidden, "forbidden", "Вам выдано только отдельное пространство этого аккаунта")
				return
			}
		} else if sc.Email != "" && !g.canEmail(a, sc.Email) {
			denyJSON(w, http.StatusForbidden, "forbidden", "Этот аккаунт вам не выдан")
			return
		}

		if sc.TokenV2 == "" && sc.SpaceID != "" && !g.canSpace(a, sc.SpaceID) {
			denyJSON(w, http.StatusForbidden, "forbidden", "Это пространство вам не выдано")
			return
		}

		next(w, r)
	}
}

// bufferedWriter captures a JSON response so it can be rewritten.
type bufferedWriter struct {
	http.ResponseWriter
	status int
	buf    bytes.Buffer
}

func (b *bufferedWriter) WriteHeader(status int) { b.status = status }

func (b *bufferedWriter) Write(p []byte) (int, error) {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	return b.buf.Write(p)
}

func (b *bufferedWriter) flush() {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	b.ResponseWriter.WriteHeader(b.status)
	_, _ = b.ResponseWriter.Write(b.buf.Bytes())
}

// FilterWorkspaces narrows /admin/workspaces to what the caller may see:
// their own accounts in full, plus accounts where an admin granted a single
// workspace (only that workspace is kept).
func (g *AccessGuard) FilterWorkspaces(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c := g.Caller(r)
		rec := &bufferedWriter{ResponseWriter: w}
		next(rec, r)

		var list []*AccountWorkspaces
		parsed := rec.status == http.StatusOK && json.Unmarshal(rec.buf.Bytes(), &list) == nil
		if parsed {
			// Learn space -> account ownership from the full (unfiltered) answer.
			g.rememberSpaceOwners(list)
		}
		if !parsed || c.AuthOff || c.IsAdmin() {
			rec.flush()
			return
		}

		a := g.allowanceFor(c)
		out := make([]*AccountWorkspaces, 0, len(list))
		for _, aw := range list {
			if aw == nil {
				continue
			}
			email := normalizeEmail(aw.UserEmail)
			if a.emails[email] {
				out = append(out, aw)
				continue
			}
			// Not the caller's account: keep only explicitly granted spaces.
			kept := make([]WorkspaceInfo, 0, len(aw.Spaces))
			for _, sp := range aw.Spaces {
				if a.spaces[strings.TrimSpace(sp.SpaceID)] {
					kept = append(kept, sp)
				}
			}
			if len(kept) == 0 {
				continue
			}
			copyAw := *aw
			copyAw.Spaces = kept
			out = append(out, &copyAw)
		}

		body, err := json.Marshal(out)
		if err != nil {
			rec.flush()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(append(body, '\n'))
	}
}

// filterAccountSpaces trims one discovered account to the workspaces the caller
// may see. An account that belongs to the caller keeps every space; an account
// where an admin granted a single workspace keeps only that workspace.
func filterAccountSpaces(acct *AccountWorkspaces, a allowance) {
	if acct == nil {
		return
	}
	if a.emails[normalizeEmail(acct.UserEmail)] {
		return
	}
	kept := make([]WorkspaceInfo, 0, len(acct.Spaces))
	for _, sp := range acct.Spaces {
		if a.spaces[strings.TrimSpace(sp.SpaceID)] {
			kept = append(kept, sp)
		}
	}
	acct.Spaces = kept
}

// FilterDiscover applies to /admin/discover the same narrowing FilterWorkspaces
// applies to the pool list. Discovery asks Notion for EVERY workspace behind a
// token, so without this a user could press "refresh" and pull in spaces of a
// partially shared account, which then also appeared in the chat picker.
func (g *AccessGuard) FilterDiscover(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c := g.Caller(r)
		rec := &bufferedWriter{ResponseWriter: w}
		next(rec, r)

		var acct AccountWorkspaces
		parsed := rec.status == http.StatusOK && json.Unmarshal(rec.buf.Bytes(), &acct) == nil
		if parsed {
			// Learn space -> account ownership from the full answer.
			g.rememberSpaceOwners([]*AccountWorkspaces{&acct})
		}
		if !parsed || c.AuthOff || c.IsAdmin() {
			rec.flush()
			return
		}

		filterAccountSpaces(&acct, g.allowanceFor(c))

		body, err := json.Marshal(&acct)
		if err != nil {
			rec.flush()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(append(body, '\n'))
	}
}
