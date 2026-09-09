package proxy

// Admin API for dashboard logins.
//
//	GET    /admin/users            list users + pool accounts for the picker
//	POST   /admin/users            create a user
//	PUT    /admin/users            update role / display name / disabled /
//	                              assigned accounts / granted workspaces
//	DELETE /admin/users?username=  delete a user
//	POST   /admin/users/password   set a password (admin: anyone, user: self)
//	GET    /admin/me               who am I + what am I allowed to do
//
// Everything except /admin/me and self-service password change is admin-only;
// that is enforced by AccessGuard.RequireAdmin in the route table.

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sort"
	"strings"
)

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("[users] encode response failed: %v", err)
	}
}

// poolAccountOption is one selectable account in the assignment UI.
type poolAccountOption struct {
	Email      string `json:"email"`
	Name       string `json:"name,omitempty"`
	SpaceName  string `json:"space_name,omitempty"`
	AssignedTo string `json:"assigned_to,omitempty"`
}

func (g *AccessGuard) poolAccountOptions() []poolAccountOption {
	out := []poolAccountOption{}
	if g.pool == nil {
		return out
	}

	// email -> username, so the UI can show who already owns an account.
	owner := map[string]string{}
	if g.store != nil {
		for _, u := range g.store.List() {
			for _, e := range u.Accounts {
				owner[normalizeEmail(e)] = u.Username
			}
		}
	}

	g.pool.mu.RLock()
	seen := map[string]bool{}
	for _, acc := range g.pool.accounts {
		email := normalizeEmail(acc.UserEmail)
		if email == "" || seen[email] {
			continue
		}
		seen[email] = true
		out = append(out, poolAccountOption{
			Email:      email,
			Name:       acc.UserName,
			SpaceName:  acc.SpaceName,
			AssignedTo: owner[email],
		})
	}
	g.pool.mu.RUnlock()

	sort.Slice(out, func(i, j int) bool { return out[i].Email < out[j].Email })
	return out
}

type createUserRequest struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	Role        string `json:"role"`
	DisplayName string `json:"display_name"`
}

type updateUserRequest struct {
	Username    string       `json:"username"`
	Role        *string      `json:"role"`
	DisplayName *string      `json:"display_name"`
	Disabled    *bool        `json:"disabled"`
	Accounts    *[]string    `json:"accounts"`
	Spaces      *[]UserSpace `json:"spaces"`
}

type passwordRequest struct {
	Username        string `json:"username"`
	Password        string `json:"password"`
	CurrentPassword string `json:"current_password"`
}

// HandleAdminUsers is the CRUD endpoint for dashboard logins.
func HandleAdminUsers(g *AccessGuard) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		store := g.Store()
		if store == nil {
			denyJSON(w, http.StatusServiceUnavailable, "no_user_store", "Реестр пользователей недоступен")
			return
		}

		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"users":         store.List(),
				"pool_accounts": g.poolAccountOptions(),
			})

		case http.MethodPost:
			var req createUserRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				denyJSON(w, http.StatusBadRequest, "bad_request", "Неверный JSON")
				return
			}
			view, err := store.Create(req.Username, req.Password, req.Role, req.DisplayName)
			if err != nil {
				status := http.StatusBadRequest
				if errors.Is(err, ErrUserExists) {
					status = http.StatusConflict
				}
				denyJSON(w, status, "create_failed", err.Error())
				return
			}
			writeJSON(w, http.StatusOK, map[string]interface{}{"user": view})

		case http.MethodPut:
			var req updateUserRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				denyJSON(w, http.StatusBadRequest, "bad_request", "Неверный JSON")
				return
			}
			if strings.TrimSpace(req.Username) == "" {
				denyJSON(w, http.StatusBadRequest, "bad_request", "Не указан логин")
				return
			}
			view, err := store.Update(req.Username, UserPatch{
				Role:        req.Role,
				DisplayName: req.DisplayName,
				Disabled:    req.Disabled,
				Accounts:    req.Accounts,
				Spaces:      req.Spaces,
			})
			if err != nil {
				status := http.StatusBadRequest
				if errors.Is(err, ErrUserNotFound) {
					status = http.StatusNotFound
				}
				denyJSON(w, status, "update_failed", err.Error())
				return
			}
			writeJSON(w, http.StatusOK, map[string]interface{}{"user": view})

		case http.MethodDelete:
			username := strings.TrimSpace(r.URL.Query().Get("username"))
			if username == "" {
				var body struct {
					Username string `json:"username"`
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				username = strings.TrimSpace(body.Username)
			}
			if username == "" {
				denyJSON(w, http.StatusBadRequest, "bad_request", "Не указан логин")
				return
			}
			caller := g.Caller(r)
			// The admin password from config.yaml is a second, independent way in,
			// so while it is set even the last admin login (including your own) may
			// be deleted: the panel stays reachable and the next start re-seeds the
			// admin/admin bootstrap login.
			allowLastAdmin := g.auth != nil && g.auth.HasAdminPassword()
			if !allowLastAdmin && NormalizeUsername(username) == NormalizeUsername(caller.Username) {
				denyJSON(w, http.StatusBadRequest, "self_delete", "Нельзя удалить самого себя")
				return
			}
			err := store.Delete(username)
			if errors.Is(err, ErrLastAdmin) && allowLastAdmin {
				err = store.DeleteAllowingLastAdmin(username)
			}
			if err != nil {
				status := http.StatusBadRequest
				if errors.Is(err, ErrUserNotFound) {
					status = http.StatusNotFound
				}
				if errors.Is(err, ErrLastAdmin) {
					status = http.StatusConflict
				}
				denyJSON(w, status, "delete_failed", err.Error())
				return
			}
			// Kill live sessions of the removed login.
			if g.auth != nil {
				g.auth.DropSessionsFor(username)
			}
			writeJSON(w, http.StatusOK, map[string]interface{}{"deleted": NormalizeUsername(username)})

		default:
			denyJSON(w, http.StatusMethodNotAllowed, "method_not_allowed", "Метод не поддерживается")
		}
	}
}

// HandleAdminUsersPassword sets a password. An admin may reset anyone's
// password; a regular user may only change their own and must confirm the
// current one.
func HandleAdminUsersPassword(g *AccessGuard) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			denyJSON(w, http.StatusMethodNotAllowed, "method_not_allowed", "Метод не поддерживается")
			return
		}
		store := g.Store()
		if store == nil {
			denyJSON(w, http.StatusServiceUnavailable, "no_user_store", "Реестр пользователей недоступен")
			return
		}

		caller := g.Caller(r)
		if !caller.AuthOff && !caller.LoggedIn {
			denyJSON(w, http.StatusUnauthorized, "unauthorized", "Требуется вход")
			return
		}

		var req passwordRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			denyJSON(w, http.StatusBadRequest, "bad_request", "Неверный JSON")
			return
		}
		target := NormalizeUsername(req.Username)
		if target == "" {
			target = NormalizeUsername(caller.Username)
		}
		if target == "" {
			denyJSON(w, http.StatusBadRequest, "bad_request", "Не указан логин")
			return
		}

		if !caller.IsAdmin() {
			if target != NormalizeUsername(caller.Username) {
				denyJSON(w, http.StatusForbidden, "forbidden", "Менять пароли других может только администратор")
				return
			}
			if _, err := store.Authenticate(target, req.CurrentPassword); err != nil {
				denyJSON(w, http.StatusForbidden, "bad_current_password", "Текущий пароль неверен")
				return
			}
		}

		if err := store.SetPassword(target, req.Password); err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, ErrUserNotFound) {
				status = http.StatusNotFound
			}
			denyJSON(w, status, "password_failed", err.Error())
			return
		}
		// Force a fresh login everywhere except the current session.
		if g.auth != nil {
			g.auth.DropOtherSessionsFor(target, r)
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "username": target})
	}
}

// HandleAdminMe reports the current identity and its permissions. The
// dashboard uses it to hide admin-only controls and to make the pay tab
// read-only for regular users.
func HandleAdminMe(g *AccessGuard) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		caller := g.Caller(r)
		if !caller.AuthOff && !caller.LoggedIn {
			denyJSON(w, http.StatusUnauthorized, "unauthorized", "Требуется вход")
			return
		}

		isAdmin := caller.IsAdmin()
		resp := map[string]interface{}{
			"username":      caller.Username,
			"role":          caller.Role,
			"is_admin":      isAdmin,
			"auth_required": !caller.AuthOff,
			"accounts":      []string{},
			"spaces":        []UserSpace{},
			"can": map[string]bool{
				"manage_users":      isAdmin,
				"manage_accounts":   isAdmin,
				"manage_workspaces": isAdmin,
				"pay":               isAdmin,
				"register":          isAdmin,
				"settings":          isAdmin,
				"chat":              true,
			},
		}
		if caller.Role == "" && isAdmin {
			resp["role"] = RoleAdmin
		}
		if store := g.Store(); store != nil && caller.Username != "" {
			if view, ok := store.View(caller.Username); ok {
				resp["display_name"] = view.DisplayName
				resp["accounts"] = view.Accounts
				resp["spaces"] = view.Spaces
			}
		}
		writeJSON(w, http.StatusOK, resp)
	}
}
