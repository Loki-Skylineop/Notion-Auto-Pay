package proxy

// Three additions that need no changes anywhere in the original dashboard code:
//
//	1. a first-run admin/admin login, so a fresh install is usable at once;
//	2. a delete path that may remove the last admin, used only while the
//	   config.yaml admin password still offers a way back in;
//	3. a wrapper that keeps the proxy API key out of the dashboard HTML for
//	   everyone who is not a signed-in admin.

import (
	"log"
	"net/http"
	"strings"
	"time"
)

// Bootstrap credentials created on a fresh install. This is a test account:
// change the password (or delete the login) before the panel is reachable by
// anyone else.
const (
	BootstrapAdminUsername = "admin"
	BootstrapAdminPassword = "admin"
)

// EnsureBootstrapAdmin creates admin/admin when users.json holds no logins at
// all, and reports whether it did.
//
// The password is shorter than ValidatePassword allows, which is why the hash
// is built here instead of going through Create: the 6-character floor still
// applies to every password typed into the UI.
func (s *UserStore) EnsureBootstrapAdmin() (bool, error) {
	if s == nil {
		return false, nil
	}
	hash, err := hashPassword(BootstrapAdminPassword)
	if err != nil {
		return false, err
	}
	now := time.Now()

	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.users) > 0 {
		return false, nil
	}
	u := &User{
		Username:     BootstrapAdminUsername,
		Role:         RoleAdmin,
		PasswordHash: hash,
		Accounts:     []string{},
		Spaces:       []UserSpace{},
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	s.users[u.Username] = u
	if err := s.saveLocked(); err != nil {
		delete(s.users, u.Username)
		return false, err
	}
	log.Printf("[users] bootstrap login created: %s / %s (role=admin)", BootstrapAdminUsername, BootstrapAdminPassword)
	return true, nil
}

// DeleteAllowingLastAdmin removes a login even when it is the only admin left.
// Callers must first make sure another way into the panel exists, which today
// means the config.yaml admin password.
func (s *UserStore) DeleteAllowingLastAdmin(username string) error {
	if s == nil {
		return ErrUserNotFound
	}
	key := NormalizeUsername(username)

	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[key]
	if !ok {
		return ErrUserNotFound
	}
	delete(s.users, key)
	if err := s.saveLocked(); err != nil {
		s.users[key] = u
		return err
	}
	log.Printf("[users] deleted %q (last-admin guard skipped: admin password still set)", key)
	return nil
}

// HideAPIKeyMeta removes the injected <meta name="api-key" ...> element from
// the dashboard HTML unless the caller is a signed-in admin.
//
// HandleDashboard writes the proxy API key into index.html, and index.html is
// served before login, so anyone able to load the login screen could read the
// key from the page source and call /v1 directly. Nothing in the SPA reads the
// tag, so dropping it costs no functionality; admins still see it, and the
// wide-open no-auth mode is left exactly as it was.
func HideAPIKeyMeta(g *AccessGuard, next http.Handler) http.Handler {
	if g == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead || !isDashboardHTMLPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		if c := g.Caller(r); c.AuthOff || c.IsAdmin() {
			next.ServeHTTP(w, r)
			return
		}

		rec := &bufferedWriter{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		if body, changed := stripAPIKeyMeta(rec.buf.Bytes()); changed {
			rec.Header().Del("Content-Length")
			rec.buf.Reset()
			_, _ = rec.buf.Write(body)
		}
		rec.flush()
	})
}

// isDashboardHTMLPath matches the requests HandleDashboard answers with
// index.html: /dashboard, /dashboard/ and the SPA routes below it. Static
// assets and the auth endpoints keep their untouched fast path.
func isDashboardHTMLPath(path string) bool {
	if path != "/dashboard" && !strings.HasPrefix(path, "/dashboard/") {
		return false
	}
	if strings.HasPrefix(path, "/dashboard/assets/") || strings.HasPrefix(path, "/dashboard/auth/") {
		return false
	}
	name := path
	if i := strings.LastIndex(path, "/"); i >= 0 {
		name = path[i+1:]
	}
	if name == "index.html" {
		return true
	}
	return !strings.Contains(name, ".")
}

// stripAPIKeyMeta drops the whole <meta name="api-key" ...> element and
// reports whether anything was removed.
func stripAPIKeyMeta(body []byte) ([]byte, bool) {
	const marker = `<meta name="api-key"`
	html := string(body)
	start := strings.Index(html, marker)
	if start < 0 {
		return body, false
	}
	end := strings.Index(html[start:], ">")
	if end < 0 {
		return body, false
	}
	return []byte(html[:start] + html[start+end+1:]), true
}
