package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func hostStoreTest(t *testing.T) *MCPHostStore {
	t.Helper()
	t.Setenv("MCP_AUTHORIZED_KEYS", filepath.Join(t.TempDir(), "authorized_keys"))
	s, e := NewMCPHostStore(filepath.Join(t.TempDir(), "mcphosts.json"))
	if e != nil {
		t.Fatal(e)
	}
	return s
}
func TestMCPHostPersistenceAndOwnership(t *testing.T) {
	s := hostStoreTest(t)
	c := Caller{Username: "alice", LoggedIn: true}
	h, e := s.create(c, "alice-pc", "full")
	if e != nil {
		t.Fatal(e)
	}
	if s.can(Caller{Username: "bob"}, h) {
		t.Fatal("cross-user access")
	}
	if !s.can(Caller{Role: RoleAdmin}, h) {
		t.Fatal("admin access")
	}
	s2, e := NewMCPHostStore(s.path)
	if e != nil || len(s2.hosts) != 1 {
		t.Fatalf("reload: %v", e)
	}
	if _, e = s.create(c, "alice-pc", "full"); e == nil {
		t.Fatal("duplicate accepted")
	}
	if e = s.change(c, h.ID, "rotate", ""); e != nil {
		t.Fatal(e)
	}
	if s.hosts[0].AuthKey == h.AuthKey || s.hosts[0].SetupToken == h.SetupToken || s.hosts[0].PublicKey == h.PublicKey {
		t.Fatal("rotation failed")
	}
	b, _ := os.ReadFile(s.authorizedKeys)
	if strings.Contains(string(b), h.PublicKey) {
		t.Fatal("old SSH key not revoked")
	}
	if e = s.change(Caller{Username: "bob"}, h.ID, "delete", ""); e == nil {
		t.Fatal("cross-user delete")
	}
	if e = s.change(c, h.ID, "delete", ""); e != nil {
		t.Fatal(e)
	}
	if len(s.hosts) != 0 {
		t.Fatal("delete")
	}
}
func TestMCPHostValidation(t *testing.T) {
	s := hostStoreTest(t)
	for _, sub := range []string{"ab", "-abc", "abc-", "ABC", "abc.foo", "foo;rm -rf", "../../bad"} {
		if _, e := s.create(Caller{AuthOff: true}, sub, "full"); e == nil {
			t.Fatalf("accepted %s", sub)
		}
	}
	if _, e := s.create(Caller{AuthOff: true}, "valid-name", "wrong"); e == nil {
		t.Fatal("mode")
	}
}
func TestMCPHostMalformedFileFailsClosed(t *testing.T) {
	p := filepath.Join(t.TempDir(), "mcphosts.json")
	os.WriteFile(p, []byte(`{"hosts":`), 0600)
	if _, e := NewMCPHostStore(p); e == nil {
		t.Fatal("corrupt file silently ignored")
	}
}
func TestMCPPolicy(t *testing.T) {
	for _, n := range []string{"PowerShell", "Registry", "Click", "Type", "FileSystem", "App", "NotionChat"} {
		if mcpAllowed("observe", n) {
			t.Fatal(n)
		}
	}
	for _, n := range []string{"Snapshot", "Screenshot", "State-Tool", "Wait"} {
		if !mcpAllowed("observe", n) {
			t.Fatal(n)
		}
	}
	if mcpAllowed("no-code", "PowerShell") || mcpAllowed("no-code", "Registry") {
		t.Fatal("code allowed")
	}
	if !mcpAllowed("full", "PowerShell") {
		t.Fatal("full")
	}
}
func TestMCPHostProxyAuthAndPolicy(t *testing.T) {
	s := hostStoreTest(t)
	count := 0
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count++
		if r.Header.Get("Cookie") != "" {
			t.Error("dashboard cookies leaked")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
	}))
	defer up.Close()
	_, ps, _ := net.SplitHostPort(strings.TrimPrefix(up.URL, "http://"))
	var port int
	json.Unmarshal([]byte(ps), &port)
	h := MCPHost{ID: "id", Sub: "my-pc", TunnelPort: port, AuthKey: "secret", Mode: "observe"}
	s.hosts = []MCPHost{h}
	handler := s.Middleware(http.NotFoundHandler())
	call := func(key, body string) int {
		r := httptest.NewRequest("POST", "http://my-pc."+s.baseDomain+"/mcp", bytes.NewBufferString(body))
		r.Header.Set("Authorization", "Bearer "+key)
		r.Header.Set("Cookie", "private=secret")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w.Code
	}
	if call("wrong", `{"method":"initialize"}`) != 401 {
		t.Fatal("bad key")
	}
	if call("secret", `{"method":"tools/call","params":{"name":"PowerShell"}}`) != 403 {
		t.Fatal("policy bypass")
	}
	if count != 0 {
		t.Fatal("blocked request reached upstream")
	}
	if call("secret", `{"method":"initialize"}`) != 200 || count != 1 {
		t.Fatal("proxy")
	}
}
func TestMCPSetupInvalidAndNoCache(t *testing.T) {
	s := hostStoreTest(t)
	s.sshHostKey = "ssh-ed25519 TESTPUBLICKEY"
	h, e := s.create(Caller{AuthOff: true}, "test-pc", "observe")
	if e != nil {
		t.Fatal(e)
	}
	w := httptest.NewRecorder()
	s.setup(w, httptest.NewRequest("GET", "https://localhost/mcpsetup/"+h.SetupToken, nil))
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("setup")
	}
	script := w.Body.String()
	if strings.Contains(script, "__PRIVATE_B64__") || !strings.Contains(mcpLauncher, "StrictHostKeyChecking=yes") {
		t.Fatal("template substitution")
	}
	w = httptest.NewRecorder()
	s.setup(w, httptest.NewRequest("GET", "https://localhost/mcpsetup/bad", nil))
	if w.Code != 404 {
		t.Fatal("bad setup token")
	}
}
func TestMCPLegacyHostFormat(t *testing.T) {
	s := hostStoreTest(t)
	h, e := s.create(Caller{AuthOff: true}, "legacy-pc", "full")
	if e != nil {
		t.Fatal(e)
	}
	h.Mode = ""
	now := time.Now().UTC()
	h.LastSeenAt = &now
	s.hosts = []MCPHost{h}
	if e = s.persistLocked(); e != nil {
		t.Fatal(e)
	}
	s2, e := NewMCPHostStore(s.path)
	if e != nil || s2.hosts[0].AuthKey != h.AuthKey || s2.hosts[0].LastSeenAt == nil {
		t.Fatal("legacy data lost")
	}
}

func TestMCPToolsListFiltered(t *testing.T) {
	b := []byte(`{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"PowerShell"},{"name":"Snapshot"},{"name":"Wait"},{"name":"Click"}]}}`)
	out := mcpFilterToolsJSON(b, "observe")
	if bytes.Contains(out, []byte("PowerShell")) || bytes.Contains(out, []byte("Click")) || !bytes.Contains(out, []byte("Snapshot")) {
		t.Fatal(string(out))
	}
	resp := &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader("event: message\ndata: " + string(b) + "\n\n"))}
	if e := mcpFilterToolsResponse(resp, "observe"); e != nil {
		t.Fatal(e)
	}
	s, e := io.ReadAll(resp.Body)
	if e != nil || bytes.Contains(s, []byte("PowerShell")) {
		t.Fatal("SSE filtering")
	}
}
