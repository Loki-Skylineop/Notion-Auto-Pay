package proxy

// Dashboard-only navigation, never a Notion token or message body. Stored per
// authenticated login, so reloads, token rotations and device changes are safe.
import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type ChatLocation struct {
	AccountID    string `json:"account_id"`
	AccountEmail string `json:"account_email,omitempty"`
	SpaceID      string `json:"space_id"`
	ThreadID     string `json:"thread_id"`
}

func (l ChatLocation) key() string {
	b, _ := json.Marshal([]string{l.AccountID, l.SpaceID})
	return string(b)
}

type ChatNavigation struct {
	Revision    uint64            `json:"revision"`
	Unavailable bool              `json:"unavailable,omitempty"`
	Active      *ChatLocation     `json:"active"`
	Threads     map[string]string `json:"threads"`
	UpdatedAt   time.Time         `json:"updated_at"`
}
type ChatNavigationStore struct {
	mu     sync.Mutex
	path   string
	loaded bool
	users  map[string]ChatNavigation
}

var errNavigationConflict = errors.New("navigation revision conflict")

func newChatNavigationStore(path string) *ChatNavigationStore {
	return &ChatNavigationStore{path: path, users: map[string]ChatNavigation{}}
}
func (s *ChatNavigationStore) loadLocked() error {
	if s.loaded {
		return nil
	}
	data, err := os.ReadFile(s.path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err == nil {
		if err := json.Unmarshal(data, &s.users); err != nil {
			return err
		}
	}
	if s.users == nil {
		s.users = map[string]ChatNavigation{}
	}
	s.loaded = true
	return nil
}
func cloneNavigation(n ChatNavigation) ChatNavigation {
	if n.Active != nil {
		l := *n.Active
		n.Active = &l
	}
	out := map[string]string{}
	for k, v := range n.Threads {
		out[k] = v
	}
	n.Threads = out
	return n
}
func (s *ChatNavigationStore) Get(owner string) (ChatNavigation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return ChatNavigation{}, err
	}
	return cloneNavigation(s.users[owner]), nil
}
func (s *ChatNavigationStore) Save(owner string, revision uint64, location ChatLocation) (ChatNavigation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return ChatNavigation{}, err
	}
	previous := s.users[owner]
	if previous.Revision != revision {
		return cloneNavigation(previous), errNavigationConflict
	}
	next := cloneNavigation(previous)
	next.Active = &location
	next.Threads[location.key()] = location.ThreadID
	next.Revision++
	next.UpdatedAt = time.Now().UTC()
	s.users[owner] = next
	data, err := json.MarshalIndent(s.users, "", "  ")
	if err == nil {
		err = os.MkdirAll(filepath.Dir(s.path), 0700)
	}
	if err == nil {
		var file *os.File
		file, err = os.CreateTemp(filepath.Dir(s.path), ".chat-navigation-*")
		if err == nil {
			temp := file.Name()
			defer os.Remove(temp)
			if err = file.Chmod(0600); err == nil {
				_, err = file.Write(data)
			}
			if err == nil {
				err = file.Sync()
			}
			closeErr := file.Close()
			if err == nil {
				err = closeErr
			}
			if err == nil {
				err = os.Rename(temp, s.path)
			}
		}
	}
	if err != nil {
		s.users[owner] = previous
		return ChatNavigation{}, err
	}
	return cloneNavigation(next), nil
}
func navigationOwner(c Caller) string {
	if c.AuthOff {
		return "@open-dashboard"
	}
	return NormalizeUsername(c.Username)
}

// Resolve a stable Notion identity to the CURRENT token, never trust a client
// username or token for ownership. The route is authenticated before dispatch.
func (g *AccessGuard) navigationAllowed(c Caller, l ChatLocation) bool {
	if g.pool == nil {
		return false
	}
	var email string
	found := false
	g.pool.mu.RLock()
	for _, a := range g.pool.accounts {
		id := strings.TrimSpace(a.UserID)
		if id == "" {
			id = normalizeEmail(a.UserEmail)
		}
		if id == l.AccountID {
			email = normalizeEmail(a.UserEmail)
			found = true
			break
		}
	}
	g.pool.mu.RUnlock()
	if !found {
		return false
	}
	if c.IsAdmin() {
		return true
	}
	allowed := g.allowanceFor(c)
	if !g.canEmail(allowed, email) {
		return false
	}
	if allowed.spaces[l.SpaceID] {
		return allowed.spaceEmails[l.SpaceID] == "" || allowed.spaceEmails[l.SpaceID] == email
	}
	return allowed.emails[email] && g.canSpace(allowed, l.SpaceID)
}
func HandleChatNavigation(g *AccessGuard) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		c := g.Caller(r)
		if !c.AuthOff && !c.LoggedIn {
			denyJSON(w, 401, "unauthorized", "Требуется вход")
			return
		}
		owner := navigationOwner(c)
		switch r.Method {
		case http.MethodGet:
			n, err := g.navigation.Get(owner)
			if err != nil {
				denyJSON(w, 500, "navigation_storage", "Не удалось загрузить выбор чата")
				return
			}
			// Revoke stale grants without leaking another account's saved navigation.
			if n.Active != nil && !g.navigationAllowed(c, *n.Active) {
				n.Active = nil
				n.Unavailable = true // No identifiers leaked, but no silent fallback either.
			}
			for key := range n.Threads {
				var ids []string
				if json.Unmarshal([]byte(key), &ids) != nil || len(ids) != 2 || !g.navigationAllowed(c, ChatLocation{AccountID: ids[0], SpaceID: ids[1]}) {
					delete(n.Threads, key)
				}
			}
			json.NewEncoder(w).Encode(n)
		case http.MethodPut:
			var body struct {
				Revision uint64       `json:"revision"`
				Location ChatLocation `json:"location"`
			}
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
				denyJSON(w, 400, "invalid_request", "Некорректный выбор")
				return
			}
			l := body.Location
			l.AccountID = strings.TrimSpace(l.AccountID)
			l.SpaceID = strings.TrimSpace(l.SpaceID)
			l.AccountEmail = normalizeEmail(l.AccountEmail)
			l.ThreadID = strings.TrimSpace(l.ThreadID)
			if l.AccountID == "" || l.SpaceID == "" || len(l.AccountID) > 256 || len(l.SpaceID) > 128 || len(l.ThreadID) > 128 {
				denyJSON(w, 400, "invalid_location", "Нужны аккаунт и пространство")
				return
			}
			if !g.navigationAllowed(c, l) {
				denyJSON(w, 403, "forbidden", "Нет доступа к этому аккаунту и пространству")
				return
			}
			n, err := g.navigation.Save(owner, body.Revision, l)
			if errors.Is(err, errNavigationConflict) {
				w.WriteHeader(409)
				json.NewEncoder(w).Encode(map[string]any{"revision": n.Revision, "error": "navigation_conflict"})
				return
			}
			if err != nil {
				denyJSON(w, 500, "navigation_storage", "Не удалось сохранить выбор чата")
				return
			}
			json.NewEncoder(w).Encode(n)
		default:
			w.Header().Set("Allow", "GET, PUT")
			denyJSON(w, 405, "method_not_allowed", "Метод не поддерживается")
		}
	}
}
