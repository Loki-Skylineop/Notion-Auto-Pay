package proxy

// One middleware that applies the access policy to every route, plus the
// multi-user auth and user-management endpoints.
//
// Doing it here instead of wrapping each mux.HandleFunc keeps the original
// route table in cmd/notion-manager/main.go untouched: main.go only wraps the
// finished mux with guard.Middleware(mux).
//
// Policy:
//
//	admin only   accounts add/delete/list, settings, stats, register,
//	             subscribe, workspace create/delete, overage toggle, autopay
//	             run / pay-space, user management, /proxy/start
//	any login    models, autopay config (GET only), chat upload, /admin/me,
//	             pool refresh
//	scoped       chat endpoints, overage status, MCP connect/disconnect: only
//	             for accounts and workspaces assigned to that login
//	filtered     /admin/workspaces and /admin/discover: trimmed to the login's
//	             own accounts plus admin-granted workspaces

import (
	"net/http"
	"strings"
)

// adminOnlyExact lists endpoints that only an admin may call at all.
var adminOnlyExact = map[string]bool{
	"/admin/accounts":          true,
	"/admin/accounts/add":      true,
	"/admin/accounts/delete":   true,
	"/admin/settings":          true,
	"/admin/api/config":        true,
	"/admin/stats":             true,
	"/admin/workspaces/create": true,
	"/admin/workspaces/delete": true,
	"/admin/overage/toggle":    true,
	"/admin/autopay/run":       true,
	"/admin/autopay/pay-space": true,
	"/proxy/start":             true,
}

// adminOnlyPrefixes covers the routed sub-trees.
var adminOnlyPrefixes = []string{
	"/admin/accounts/",
	"/admin/register",
	"/admin/subscribe",
}

// RequireLogin allows any authenticated session through and rejects the rest.
func (g *AccessGuard) RequireLogin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c := g.Caller(r)
		if c.AuthOff || c.LoggedIn {
			next(w, r)
			return
		}
		denyJSON(w, http.StatusUnauthorized, "unauthorized", "Требуется вход")
	}
}

func isAdminOnlyPath(path string) bool {
	if adminOnlyExact[path] {
		return true
	}
	for _, p := range adminOnlyPrefixes {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

// Middleware enforces the whole access policy in front of the mux.
func (g *AccessGuard) Middleware(next http.Handler) http.Handler {
	pass := next.ServeHTTP

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		// Auth + user management are served here, ahead of the mux, so the
		// dashboard's own /dashboard/auth/* handlers stay as they are.
		switch path {
		case "/dashboard/auth/login":
			g.auth.HandleAuthLoginMulti()(w, r)
			return
		case "/dashboard/auth/check":
			g.auth.HandleAuthCheckMulti()(w, r)
			return
		case "/dashboard/auth/salt":
			g.auth.HandleAuthSaltMulti()(w, r)
			return
		case "/admin/users":
			g.RequireAdmin(HandleAdminUsers(g))(w, r)
			return
		case "/admin/users/password":
			// Admins reset anyone's password; a user may change their own.
			g.RequireLogin(HandleAdminUsersPassword(g))(w, r)
			return
		case "/admin/me":
			g.RequireLogin(HandleAdminMe(g))(w, r)
			return
		}

		if !strings.HasPrefix(path, "/admin/") && path != "/proxy/start" {
			pass(w, r)
			return
		}

		switch {
		case isAdminOnlyPath(path):
			g.RequireAdmin(pass)(w, r)

		case path == "/admin/discover":
			// A user may re-scan their own accounts, but the answer is trimmed to
			// the workspaces an admin granted: discovery asks Notion for every
			// space behind the token, so one refresh would otherwise reveal (and
			// then offer in the chat picker) spaces that were never handed over.
			g.RequireLogin(g.Scoped(g.FilterDiscover(pass)))(w, r)

		case path == "/admin/mcp/connect", path == "/admin/mcp/disconnect":
			// Scoped matches token_v2 / space_id against the accounts and
			// workspaces an admin granted to that login.
			g.RequireLogin(g.Scoped(pass))(w, r)

		case path == "/admin/refresh":
			// The pool refresh runs in the background and returns no data, so
			// a login is enough; there is no payload to scope.
			g.RequireLogin(pass)(w, r)

		case path == "/admin/workspaces":
			// Everyone sees a workspace list, just not the same one.
			g.RequireLogin(g.FilterWorkspaces(pass))(w, r)

		case path == "/admin/autopay":
			// The pay tab stays readable for users, editable for admins.
			g.RequireLogin(g.AdminOnWrite(pass))(w, r)

		case path == "/admin/chat/upload":
			// Multipart body: not inspected here to avoid buffering uploads.
			// The follow-up /admin/chat/send is scoped, so an attachment is
			// useless without an authorized workspace.
			g.RequireLogin(pass)(w, r)

		case strings.HasPrefix(path, "/admin/chat/"), path == "/admin/overage/status":
			g.RequireLogin(g.Scoped(pass))(w, r)

		default:
			// /admin/models and anything added later: login required.
			g.RequireLogin(pass)(w, r)
		}
	})
}
