package proxy

// MCP host management restored from the surviving deployment's on-disk format.
// Secrets stay in mcphosts.json (0600), never in git or application logs.
import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"golang.org/x/crypto/ssh"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type MCPHost struct {
	ID         string     `json:"id"`
	Owner      string     `json:"owner"`
	Sub        string     `json:"sub"`
	TunnelPort int        `json:"tunnel_port"`
	AuthKey    string     `json:"auth_key"`
	SetupToken string     `json:"setup_token"`
	PublicKey  string     `json:"public_key"`
	PrivateKey string     `json:"private_key"`
	CreatedAt  time.Time  `json:"created_at"`
	LastSeenAt *time.Time `json:"last_seen_at,omitempty"`
	Mode       string     `json:"mode,omitempty"`
}
type MCPHostStore struct {
	mu                                                       sync.RWMutex
	path, baseDomain, tunnelHost, authorizedKeys, sshHostKey string
	hosts                                                    []MCPHost
}

var mcpSubPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$`)

func mcpSecret(n int) (string, error) {
	b := make([]byte, n)
	_, e := rand.Read(b)
	return hex.EncodeToString(b), e
}
func mcpEqual(a, b string) bool {
	return a != "" && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
func mcpMode(m string) bool { return m == "full" || m == "no-code" || m == "observe" }
func NewMCPHostStore(path string) (*MCPHostStore, error) {
	s := &MCPHostStore{path: path, baseDomain: strings.ToLower(strings.TrimSpace(os.Getenv("MCP_BASE_DOMAIN"))), tunnelHost: strings.TrimSpace(os.Getenv("MCP_TUNNEL_HOST")), authorizedKeys: os.Getenv("MCP_AUTHORIZED_KEYS"), sshHostKey: strings.TrimSpace(os.Getenv("MCP_SSH_HOST_KEY"))}
	if s.baseDomain == "" {
		s.baseDomain = "31.76.119.238.nip.io"
	}
	if s.tunnelHost == "" {
		s.tunnelHost = "31.76.119.238"
	}
	if runtime.GOOS == "linux" && s.authorizedKeys == "" {
		s.authorizedKeys = "/home/mcptun/.ssh/authorized_keys"
	}
	b, e := os.ReadFile(path)
	if errors.Is(e, os.ErrNotExist) {
		return s, nil
	}
	if e != nil {
		return nil, e
	}
	var d struct {
		Version int       `json:"version"`
		Hosts   []MCPHost `json:"hosts"`
	}
	if e = json.Unmarshal(b, &d); e != nil {
		return nil, fmt.Errorf("MCP hosts file: %w", e)
	}
	subs := map[string]bool{}
	ports := map[int]bool{}
	for _, h := range d.Hosts {
		if (h.Mode != "" && !mcpMode(h.Mode)) || !mcpSubPattern.MatchString(h.Sub) || h.TunnelPort < 8300 || h.TunnelPort > 8999 || subs[h.Sub] || ports[h.TunnelPort] || h.ID == "" || h.AuthKey == "" || h.SetupToken == "" {
			return nil, errors.New("invalid or duplicate MCP host record")
		}
		subs[h.Sub] = true
		ports[h.TunnelPort] = true
	}
	s.hosts = d.Hosts
	return s, nil
}
func (s *MCPHostStore) persistLocked() error {
	b, e := json.MarshalIndent(struct {
		Version int       `json:"version"`
		Hosts   []MCPHost `json:"hosts"`
	}{1, s.hosts}, "", "  ")
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(s.path), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(s.path), ".mcphosts-*")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(0600); e != nil {
		f.Close()
		return e
	}
	if _, e = f.Write(b); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return os.Rename(name, s.path)
}

// Sync only the keys managed by this feature; unrelated manually-added keys survive.
func (s *MCPHostStore) syncKeysLocked(previous []MCPHost) error {
	if s.authorizedKeys == "" {
		return nil
	}
	existing, e := os.ReadFile(s.authorizedKeys)
	if e != nil && !errors.Is(e, os.ErrNotExist) {
		return e
	}
	managed := map[string]bool{}
	for _, h := range append(append([]MCPHost{}, previous...), s.hosts...) {
		fields := strings.Fields(h.PublicKey)
		if len(fields) > 1 {
			managed[fields[1]] = true
		}
	}
	var lines []string
	for _, l := range strings.Split(string(existing), "\n") {
		if strings.TrimSpace(l) == "" || strings.HasPrefix(l, "# Managed by notion-manager") {
			continue
		}
		remove := false
		for k := range managed {
			if strings.Contains(l, k) {
				remove = true
				break
			}
		}
		if !remove {
			lines = append(lines, l)
		}
	}
	lines = append(lines, "# Managed by notion-manager (MCP tab).")
	for _, h := range s.hosts {
		if _, _, _, _, e := ssh.ParseAuthorizedKey([]byte(h.PublicKey)); e != nil {
			return errors.New("invalid SSH public key")
		}
		lines = append(lines, fmt.Sprintf("restrict,port-forwarding,permitlisten=\"127.0.0.1:%d\",permitopen=\"127.0.0.1:1\" %s", h.TunnelPort, strings.TrimSpace(h.PublicKey)))
	}
	dir := filepath.Dir(s.authorizedKeys)
	if e = os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(dir, ".mcp-keys-*")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(0600); e != nil {
		f.Close()
		return e
	}
	if _, e = f.WriteString(strings.Join(lines, "\n") + "\n"); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	if u, e := user.Lookup("mcptun"); e == nil {
		uid, _ := strconv.Atoi(u.Uid)
		gid, _ := strconv.Atoi(u.Gid)
		if e = os.Chown(name, uid, gid); e != nil {
			return e
		}
	}
	return os.Rename(name, s.authorizedKeys)
}
func (s *MCPHostStore) commitLocked(previous []MCPHost) error {
	if e := s.syncKeysLocked(previous); e != nil {
		s.hosts = previous
		return e
	}
	if e := s.persistLocked(); e != nil {
		current := s.hosts
		s.hosts = previous
		_ = s.syncKeysLocked(current)
		return e
	}
	return nil
}
func mcpKeypair(h *MCPHost) error {
	pub, priv, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		return e
	}
	p, e := ssh.NewPublicKey(pub)
	if e != nil {
		return e
	}
	block, e := ssh.MarshalPrivateKey(priv, "notion-mcp")
	if e != nil {
		return e
	}
	h.PublicKey = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(p)))
	h.PrivateKey = string(pem.EncodeToMemory(block))
	h.AuthKey, e = mcpSecret(32)
	if e != nil {
		return e
	}
	h.SetupToken, e = mcpSecret(32)
	return e
}
func (s *MCPHostStore) can(c Caller, h MCPHost) bool { return c.IsAdmin() || c.Username == h.Owner }
func (s *MCPHostStore) create(c Caller, sub, mode string) (MCPHost, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !mcpSubPattern.MatchString(sub) {
		return MCPHost{}, errors.New("Адрес: 3–30 строчных латинских букв, цифр и дефисов; без дефиса по краям")
	}
	if !mcpMode(mode) {
		return MCPHost{}, errors.New("Неизвестный режим доступа")
	}
	used := map[int]bool{}
	count := 0
	for _, h := range s.hosts {
		if h.Sub == sub {
			return MCPHost{}, errors.New("Этот адрес уже занят")
		}
		used[h.TunnelPort] = true
		if h.Owner == c.Username {
			count++
		}
	}
	if count >= 20 && !c.IsAdmin() {
		return MCPHost{}, errors.New("Достигнут лимит: 20 хостов")
	}
	port := 8300
	for used[port] && port <= 8999 {
		port++
	}
	if port > 8999 {
		return MCPHost{}, errors.New("Нет свободных портов")
	}
	id, e := mcpSecret(8)
	if e != nil {
		return MCPHost{}, e
	}
	owner := c.Username
	if owner == "" {
		owner = "@admin"
	}
	h := MCPHost{ID: id, Owner: owner, Sub: sub, TunnelPort: port, CreatedAt: time.Now().UTC(), Mode: mode}
	if e = mcpKeypair(&h); e != nil {
		return h, e
	}
	previous := append([]MCPHost{}, s.hosts...)
	s.hosts = append(s.hosts, h)
	return h, s.commitLocked(previous)
}
func (s *MCPHostStore) change(c Caller, id, operation, mode string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous := append([]MCPHost{}, s.hosts...)
	for i, h := range s.hosts {
		if h.ID != id || !s.can(c, h) {
			continue
		}
		switch operation {
		case "delete":
			s.hosts = append(s.hosts[:i:i], s.hosts[i+1:]...)
		case "rotate":
			if e := mcpKeypair(&s.hosts[i]); e != nil {
				s.hosts = previous
				return e
			}
		case "mode":
			if !mcpMode(mode) {
				return errors.New("Неизвестный режим")
			}
			s.hosts[i].Mode = mode
		default:
			return errors.New("invalid operation")
		}
		return s.commitLocked(previous)
	}
	return os.ErrNotExist
}
func mcpJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func (s *MCPHostStore) Register(mux *http.ServeMux, g *AccessGuard) {
	mux.HandleFunc("/admin/mcphost", func(w http.ResponseWriter, r *http.Request) { s.admin(w, r, g) })
	mux.HandleFunc("/admin/mcphost/rotate", func(w http.ResponseWriter, r *http.Request) { s.admin(w, r, g) })
	mux.HandleFunc("/admin/mcphost/mode", func(w http.ResponseWriter, r *http.Request) { s.admin(w, r, g) })
	mux.HandleFunc("/mcpsetup/", s.setup)
	mux.HandleFunc("/mcp/cert-check", func(w http.ResponseWriter, r *http.Request) {
		name := strings.ToLower(r.URL.Query().Get("domain"))
		if s.knownDomain(name) || name == s.baseDomain || name == "most."+s.baseDomain {
			w.WriteHeader(200)
		} else {
			w.WriteHeader(403)
		}
	})
}
func (s *MCPHostStore) admin(w http.ResponseWriter, r *http.Request, g *AccessGuard) {
	c := g.Caller(r)
	if !c.AuthOff && !c.LoggedIn {
		mcpJSON(w, 401, map[string]string{"error": "Требуется вход"})
		return
	}
	if r.Method != "GET" && r.Header.Get("Origin") != "" {
		u, e := url.Parse(r.Header.Get("Origin"))
		if e != nil || !strings.EqualFold(u.Host, r.Host) {
			mcpJSON(w, 403, map[string]string{"error": "Недопустимый Origin"})
			return
		}
	}
	if r.Method == "GET" && r.URL.Path == "/admin/mcphost" {
		s.mu.RLock()
		hosts := append([]MCPHost{}, s.hosts...)
		s.mu.RUnlock()
		views := []map[string]any{}
		for _, h := range hosts {
			if !s.can(c, h) {
				continue
			}
			mode := h.Mode
			if mode == "" {
				mode = "full"
			}
			conn, e := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", h.TunnelPort), 150*time.Millisecond)
			online := e == nil
			if conn != nil {
				conn.Close()
			}
			views = append(views, map[string]any{"id": h.ID, "owner": h.Owner, "sub": h.Sub, "tunnel_port": h.TunnelPort, "url": "https://" + h.Sub + "." + s.baseDomain + "/mcp", "auth_key": h.AuthKey, "setup_command": "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; irm https://" + s.baseDomain + "/mcpsetup/" + h.SetupToken + " | iex", "mode": mode, "online": online, "created_at": h.CreatedAt, "last_seen_at": h.LastSeenAt})
		}
		mcpJSON(w, 200, map[string]any{"hosts": views, "base_domain": s.baseDomain, "tunnel_host": s.tunnelHost, "local_panel": runtime.GOOS != "linux"})
		return
	}
	var b struct {
		ID   string `json:"id"`
		Sub  string `json:"sub"`
		Mode string `json:"mode"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if e := json.NewDecoder(r.Body).Decode(&b); e != nil {
		mcpJSON(w, 400, map[string]string{"error": "Некорректный JSON"})
		return
	}
	var e error
	switch {
	case r.Method == "POST" && r.URL.Path == "/admin/mcphost":
		_, e = s.create(c, b.Sub, b.Mode)
	case r.Method == "DELETE" && r.URL.Path == "/admin/mcphost":
		e = s.change(c, b.ID, "delete", "")
	case r.Method == "POST" && r.URL.Path == "/admin/mcphost/rotate":
		e = s.change(c, b.ID, "rotate", "")
	case r.Method == "POST" && r.URL.Path == "/admin/mcphost/mode":
		e = s.change(c, b.ID, "mode", b.Mode)
	default:
		mcpJSON(w, 405, map[string]string{"error": "Метод не поддерживается"})
		return
	}
	if e != nil {
		status := 400
		if errors.Is(e, os.ErrNotExist) {
			status = 404
		}
		mcpJSON(w, status, map[string]string{"error": e.Error()})
		return
	}
	mcpJSON(w, 200, map[string]bool{"ok": true})
}
func (s *MCPHostStore) knownDomain(name string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, h := range s.hosts {
		if name == h.Sub+"."+s.baseDomain {
			return true
		}
	}
	return false
}
func mcpAllowed(mode, name string) bool {
	name = strings.TrimSuffix(strings.ToLower(name), "-tool")
	if mode == "observe" {
		switch name {
		case "snapshot", "screenshot", "state", "wait":
			return true
		}
		return false
	}
	if mode == "no-code" {
		// Explicit allow-list: new tools must not silently gain access.
		switch name {
		case "snapshot", "screenshot", "state", "wait", "click", "type", "scroll", "move", "shortcut", "multiselect", "multiedit", "clipboard", "app", "filesystem", "process", "notification":
			return true
		}
		return false
	}
	return true
}

// Host routing is outside dashboard authentication. Each public host has its own
// bearer key; dashboard sessions/API keys cannot authorize access to a computer.
func (s *MCPHostStore) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.ToLower(r.Host)
		if host, _, e := net.SplitHostPort(name); e == nil {
			name = host
		}
		if name == s.baseDomain || !strings.HasSuffix(name, "."+s.baseDomain) {
			next.ServeHTTP(w, r)
			return
		}
		s.mu.RLock()
		var h MCPHost
		for _, x := range s.hosts {
			if name == x.Sub+"."+s.baseDomain {
				h = x
				break
			}
		}
		s.mu.RUnlock()
		if h.ID == "" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path != "/mcp" && r.URL.Path != "/mcp/" {
			http.NotFound(w, r)
			return
		}
		key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !mcpEqual(key, h.AuthKey) {
			w.Header().Set("WWW-Authenticate", "Bearer")
			mcpJSON(w, 401, map[string]string{"error": "invalid MCP bearer token"})
			return
		}
		listTools := false
		if r.Method == "POST" {
			r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
			b, e := io.ReadAll(r.Body)
			if e != nil {
				http.Error(w, "request too large", 413)
				return
			}
			var request struct {
				Method string `json:"method"`
				Params struct {
					Name string `json:"name"`
				} `json:"params"`
			}
			if e = json.Unmarshal(b, &request); e != nil {
				http.Error(w, "invalid JSON-RPC", 400)
				return
			}
			listTools = request.Method == "tools/list"
			if request.Method == "tools/call" && !mcpAllowed(h.Mode, request.Params.Name) {
				mcpJSON(w, 403, map[string]string{"error": "tool disabled by host policy"})
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(b))
			r.ContentLength = int64(len(b))
		}
		target := &url.URL{Scheme: "http", Host: fmt.Sprintf("127.0.0.1:%d", h.TunnelPort)}
		p := httputil.NewSingleHostReverseProxy(target)
		director := p.Director
		p.Director = func(req *http.Request) {
			director(req)
			req.Host = target.Host
			req.Header.Del("Cookie")
			req.Header.Del("X-API-Key")
			req.Header.Set("Authorization", "Bearer "+h.AuthKey)
			// Local MCP sees a loopback Host, avoiding DNS-rebinding validation failures.
			req.Header.Del("Origin")
			req.Header.Set("X-Forwarded-Host", name)
			if listTools {
				req.Header.Set("Accept-Encoding", "identity")
			}
		}
		p.ModifyResponse = func(resp *http.Response) error {
			if location := resp.Header.Get("Location"); location != "" {
				if u, e := url.Parse(location); e == nil && u.Host == target.Host {
					u.Scheme = "https"
					u.Host = name
					resp.Header.Set("Location", u.String())
				}
			}
			if listTools && h.Mode != "" && h.Mode != "full" {
				return mcpFilterToolsResponse(resp, h.Mode)
			}
			return nil
		}
		p.FlushInterval = -1
		p.ErrorHandler = func(w http.ResponseWriter, r *http.Request, e error) {
			mcpJSON(w, 502, map[string]string{"error": "Туннель не поднят. Запустите установочный скрипт на ПК."})
		}
		p.ServeHTTP(w, r)
	})
}
