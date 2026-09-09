package proxy

// Sessions with an identity.
//
// The stock dashboard had one shared password and its sessions carried no
// identity at all (sessions map: id -> expiry). Instead of changing that
// struct, this file keeps a side table id -> {username, role} and adds
// multi-user versions of the login/check endpoints:
//
//	POST /dashboard/auth/login  {"username":"ivan","password":"..."}
//	                            {"hash":"..."}  (legacy admin, still works)
//	GET  /dashboard/auth/check  -> authenticated / required / username / role
//
// The legacy path stays alive on purpose: the config.yaml admin_password is
// the bootstrap login used to create the very first users.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// legacyAdminUsername is the identity given to a session opened with the
// config.yaml admin password rather than a users.json entry.
const legacyAdminUsername = "admin"

type sessionIdentity struct {
	Username string
	Role     string
}

// sessionIdentities maps a dashboard session id to who owns it.
var sessionIdentities sync.Map

// userStorePtr is the process-wide registry, attached once at startup.
var userStorePtr atomic.Pointer[UserStore]

// AttachUserStore publishes the user registry to the auth layer.
func AttachUserStore(store *UserStore) { userStorePtr.Store(store) }

// UserStoreRef returns the attached registry, or nil in legacy
// single-password mode.
func UserStoreRef() *UserStore { return userStorePtr.Load() }

func userStoreHasUsers() bool {
	s := userStorePtr.Load()
	return s != nil && s.HasUsers()
}

// AuthRequired reports whether a login is needed: either an admin password is
// configured or named users exist. HasAdminPassword() alone is not enough once
// users.json is in play.
func (da *DashboardAuth) AuthRequired() bool {
	if da == nil {
		return false
	}
	return da.adminPasswordHash != "" || userStoreHasUsers()
}

// adminClientHash reproduces the hash the browser used to send for the legacy
// admin password: SHA256(salt + password).
func adminClientHash(salt, password string) string {
	sum := sha256.Sum256([]byte(salt + password))
	return hex.EncodeToString(sum[:])
}

// createSessionFor opens a session bound to a username and role.
func (da *DashboardAuth) createSessionFor(w http.ResponseWriter, username, role string) {
	id := generateUUIDv4()
	da.sessions.Store(id, time.Now().Add(24*time.Hour))
	sessionIdentities.Store(id, sessionIdentity{
		Username: NormalizeUsername(username),
		Role:     normalizeRole(role),
	})
	http.SetCookie(w, &http.Cookie{
		Name: "dashboard_session", Value: id, Path: "/",
		HttpOnly: true, MaxAge: 86400, SameSite: http.SameSiteLaxMode,
	})
}

// CallerFor resolves the identity behind a request. It also enforces live
// revocation: a user deleted or disabled mid-session stops being authorized
// on the very next request.
func (da *DashboardAuth) CallerFor(r *http.Request) Caller {
	if da == nil {
		return Caller{AuthOff: true, Role: RoleAdmin}
	}
	if !da.AuthRequired() {
		// No password and no users: the original wide-open dashboard.
		return Caller{AuthOff: true, Role: RoleAdmin}
	}

	cookie, err := r.Cookie("dashboard_session")
	if err != nil || cookie.Value == "" {
		return Caller{}
	}
	if !da.ValidateSession(r) {
		sessionIdentities.Delete(cookie.Value)
		return Caller{}
	}

	c := Caller{LoggedIn: true}
	if v, ok := sessionIdentities.Load(cookie.Value); ok {
		id := v.(sessionIdentity)
		c.Username = id.Username
		c.Role = id.Role
	} else {
		// Session opened by the legacy admin-password path (or before this
		// build): treat it as the bootstrap admin.
		c.Username = legacyAdminUsername
		c.Role = RoleAdmin
	}

	if store := UserStoreRef(); store != nil && c.Username != "" {
		if u, ok := store.Get(c.Username); ok {
			if u.Disabled {
				return Caller{}
			}
			c.Role = u.Role // role changes take effect without re-login
		} else if c.Username != legacyAdminUsername {
			// The login was removed while the session was still open.
			return Caller{}
		}
	}
	return c
}

// DropSessionsFor invalidates every open session of one login.
func (da *DashboardAuth) DropSessionsFor(username string) {
	target := NormalizeUsername(username)
	sessionIdentities.Range(func(k, v interface{}) bool {
		if id, ok := v.(sessionIdentity); ok && id.Username == target {
			sessionIdentities.Delete(k)
			da.sessions.Delete(k)
		}
		return true
	})
}

// DropOtherSessionsFor invalidates a login's sessions except the one making
// the current request, so changing your own password does not log you out.
func (da *DashboardAuth) DropOtherSessionsFor(username string, r *http.Request) {
	current := ""
	if c, err := r.Cookie("dashboard_session"); err == nil {
		current = c.Value
	}
	target := NormalizeUsername(username)
	sessionIdentities.Range(func(k, v interface{}) bool {
		key, _ := k.(string)
		if key == current {
			return true
		}
		if id, ok := v.(sessionIdentity); ok && id.Username == target {
			sessionIdentities.Delete(k)
			da.sessions.Delete(k)
		}
		return true
	})
}

// HandleAuthLoginMulti authenticates either a users.json login
// ({username, password}, bcrypt) or the legacy admin password
// ({hash}, or {username:"admin", password}). Rate limiting is shared with the
// original handler, so brute-force protection still applies per client IP.
func (da *DashboardAuth) HandleAuthLoginMulti() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		ip := dashboardClientIP(r)
		if ok, retryAfter := da.loginAllowed(ip); !ok {
			secs := int(retryAfter.Seconds()) + 1
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Retry-After", strconv.Itoa(secs))
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"error":       "too many attempts, try again later",
				"retry_after": secs,
			})
			log.Printf("[dashboard] login rate-limited for %s (%ds left)", ip, secs)
			return
		}

		var body struct {
			Username string `json:"username"`
			Password string `json:"password"`
			Hash     string `json:"hash"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			log.Printf("[dashboard] login from %s — bad request body: %v", ip, err)
			http.Error(w, `{"error":"invalid body"}`, http.StatusBadRequest)
			return
		}

		username := NormalizeUsername(body.Username)
		store := UserStoreRef()

		// 1) Named user from users.json.
		if store != nil && username != "" {
			if _, exists := store.Get(username); exists {
				u, err := store.Authenticate(username, body.Password)
				if err != nil {
					da.recordLoginFailure(ip)
					msg := "Неверный логин или пароль"
					if errors.Is(err, ErrUserDisabled) {
						msg = "Доступ отключён администратором"
					}
					log.Printf("[dashboard] FAILED login for %q from %s: %v", username, ip, err)
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusUnauthorized)
					_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
					return
				}
				da.recordLoginSuccess(ip)
				da.createSessionFor(w, u.Username, u.Role)
				log.Printf("[dashboard] login success %q (role=%s) from %s", u.Username, u.Role, ip)
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]interface{}{
					"status":   "ok",
					"username": u.Username,
					"role":     u.Role,
					"is_admin": u.IsAdmin(),
				})
				return
			}
		}

		// 2) Legacy admin password from config.yaml — the bootstrap login that
		// creates the first users. Accepts a client-side hash (old frontend) or
		// a plaintext password hashed here (new frontend).
		if da.adminPasswordHash != "" && (username == "" || username == legacyAdminUsername) {
			clientHash := body.Hash
			if clientHash == "" && body.Password != "" {
				clientHash = adminClientHash(AdminPasswordSalt(da.adminPasswordHash), body.Password)
			}
			if VerifyAdminPassword(da.adminPasswordHash, clientHash) {
				da.recordLoginSuccess(ip)
				da.createSessionFor(w, legacyAdminUsername, RoleAdmin)
				log.Printf("[dashboard] login success (config admin password) from %s", ip)
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]interface{}{
					"status":   "ok",
					"username": legacyAdminUsername,
					"role":     RoleAdmin,
					"is_admin": true,
				})
				return
			}
		}

		da.recordLoginFailure(ip)
		log.Printf("[dashboard] FAILED login from %s (username=%q)", ip, username)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Неверный логин или пароль"})
	}
}

// HandleAuthCheckMulti reports session state plus who is logged in.
func (da *DashboardAuth) HandleAuthCheckMulti() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c := da.CallerFor(r)
		authenticated := c.AuthOff || c.LoggedIn
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"authenticated": authenticated,
			"required":      da.AuthRequired(),
			"username":      c.Username,
			"role":          c.Role,
			"is_admin":      authenticated && c.IsAdmin(),
		})
	}
}

// HandleAuthSaltMulti mirrors the original salt endpoint but reports the
// combined "login required" state so the SPA shows the form when users.json
// has entries even without a config admin password.
func (da *DashboardAuth) HandleAuthSaltMulti() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"salt":     AdminPasswordSalt(da.adminPasswordHash),
			"required": da.AuthRequired(),
		})
	}
}
