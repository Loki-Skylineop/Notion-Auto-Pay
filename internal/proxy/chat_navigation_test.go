package proxy

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestChatNavigationPersistenceIsolationAndConflict(t *testing.T) {
	path := filepath.Join(t.TempDir(), "navigation.json")
	s := newChatNavigationStore(path)
	a := ChatLocation{AccountID: "notion-a", SpaceID: "space-a", ThreadID: "thread-a"}
	b := ChatLocation{AccountID: "notion-b", SpaceID: "space-b", ThreadID: "thread-b"}
	n, err := s.Save("alice", 0, a)
	if err != nil || n.Revision != 1 {
		t.Fatalf("save: %+v %v", n, err)
	}
	n, err = s.Save("alice", 1, b)
	if err != nil || n.Threads[a.key()] != "thread-a" || n.Threads[b.key()] != "thread-b" {
		t.Fatalf("per-space memory: %+v %v", n, err)
	}
	if _, err = s.Save("bob", 0, a); err != nil {
		t.Fatal(err)
	}
	n, err = s.Save("alice", 0, a)
	if !errors.Is(err, errNavigationConflict) || n.Revision != 2 {
		t.Fatalf("conflict: %+v %v", n, err)
	}
	restarted := newChatNavigationStore(path)
	n, err = restarted.Get("alice")
	if err != nil || n.Active.SpaceID != b.SpaceID || n.Revision != 2 {
		t.Fatalf("restart: %+v %v", n, err)
	}
	n.Active.SpaceID = "mutated"
	n.Threads[a.key()] = "mutated"
	original, _ := restarted.Get("alice")
	if original.Active.SpaceID != b.SpaceID || original.Threads[a.key()] != a.ThreadID {
		t.Fatal("Get leaked mutable storage")
	}
	other, _ := restarted.Get("bob")
	if other.Active.SpaceID != a.SpaceID || other.Revision != 1 {
		t.Fatal("login isolation failed")
	}
	fresh, _ := restarted.Get("new-login")
	if fresh.Active != nil || len(fresh.Threads) != 0 {
		t.Fatal("new login inherited selection")
	}
}

func TestChatNavigationWriteFailureRollsBack(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "file")
	if err := os.WriteFile(blocker, []byte("block"), 0600); err != nil {
		t.Fatal(err)
	}
	s := newChatNavigationStore(filepath.Join(blocker, "navigation.json"))
	s.loaded = true
	if _, err := s.Save("alice", 0, ChatLocation{AccountID: "a", SpaceID: "s"}); err == nil {
		t.Fatal("expected write failure")
	}
	n, err := s.Get("alice")
	if err != nil || n.Revision != 0 || n.Active != nil {
		t.Fatalf("failed write not rolled back: %+v %v", n, err)
	}
}

func TestChatNavigationHandlerDevicesPermissionsAndRevocation(t *testing.T) {
	previous := UserStoreRef()
	defer AttachUserStore(previous)
	store := &UserStore{path: filepath.Join(t.TempDir(), "users.json"), users: map[string]*User{
		"alice": {Username: "alice", Role: RoleUser, Spaces: []UserSpace{{AccountEmail: "a@example.com", SpaceID: "space-a"}}},
		"bob":   {Username: "bob", Role: RoleUser, Accounts: []string{"b@example.com"}},
	}}
	AttachUserStore(store)
	auth := &DashboardAuth{adminPasswordHash: "test-only"}
	pool := &AccountPool{accounts: []*Account{{UserID: "notion-a", UserEmail: "a@example.com", TokenV2: "fake-token-a", SpaceID: "space-a"}, {UserID: "notion-b", UserEmail: "b@example.com", TokenV2: "fake-token-b", SpaceID: "space-b"}}}
	g := NewAccessGuard(auth, store, pool)
	handler := g.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("navigation route fell through middleware")
		w.WriteHeader(404)
	}))
	cookie := func(user string) *http.Cookie {
		w := httptest.NewRecorder()
		auth.createSessionFor(w, user, RoleUser)
		return w.Result().Cookies()[0]
	}
	first, second, bob := cookie("alice"), cookie("alice"), cookie("bob")
	request := func(method string, c *http.Cookie, revision uint64, l ChatLocation) *httptest.ResponseRecorder {
		payload, _ := json.Marshal(map[string]any{"revision": revision, "location": l, "username": "bob"})
		r := httptest.NewRequest(method, "/admin/chat/navigation", bytes.NewReader(payload))
		if c != nil {
			r.AddCookie(c)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	a := ChatLocation{AccountID: "notion-a", SpaceID: "space-a", ThreadID: "thread-a"}
	if w := request("PUT", first, 0, a); w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	w := request("GET", second, 0, a)
	var n ChatNavigation
	if err := json.Unmarshal(w.Body.Bytes(), &n); err != nil || w.Code != 200 || n.Active == nil || n.Active.ThreadID != "thread-a" {
		t.Fatalf("second device: %s %v", w.Body.String(), err)
	}
	if strings.Contains(w.Body.String(), "fake-token") {
		t.Fatal("token leaked")
	}
	if w := request("GET", bob, 0, a); strings.Contains(w.Body.String(), "thread-a") {
		t.Fatal("another login inherited navigation")
	}
	if w := request("PUT", first, 1, ChatLocation{AccountID: "notion-b", SpaceID: "space-b"}); w.Code != 403 {
		t.Fatalf("foreign account accepted: %d", w.Code)
	}
	if w := request("PUT", first, 1, ChatLocation{AccountID: "notion-a", SpaceID: "other-space"}); w.Code != 403 {
		t.Fatalf("ungranted space accepted: %d", w.Code)
	}
	if w := request("PUT", second, 0, a); w.Code != 409 {
		t.Fatalf("stale device revision accepted: %d", w.Code)
	}
	if w := request("GET", nil, 0, a); w.Code != 401 {
		t.Fatalf("anonymous accepted: %d", w.Code)
	}
	pool.accounts[0].TokenV2 = "rotated"
	pool.accounts[0].UserEmail = "A@EXAMPLE.COM"
	if w := request("GET", second, 0, a); !strings.Contains(w.Body.String(), "thread-a") {
		t.Fatal("token rotation lost identity")
	}
	store.mu.Lock()
	store.users["alice"].Spaces = nil
	store.mu.Unlock()
	w = request("GET", second, 0, a)
	if strings.Contains(w.Body.String(), "thread-a") {
		t.Fatal("revoked grant still exposed selection")
	}
	if err := json.Unmarshal(w.Body.Bytes(), &n); err != nil || !n.Unavailable || n.Active != nil {
		t.Fatalf("revoked target should require explicit replacement: %s", w.Body.String())
	}
	saved, _ := g.navigation.Get("alice")
	if saved.Active == nil {
		t.Fatal("GET unexpectedly modified persisted selection")
	}
}
