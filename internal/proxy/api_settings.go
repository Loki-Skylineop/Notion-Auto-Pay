package proxy

// API tab backend.
//
// The dashboard's "API" tab needs three things the rest of the codebase never
// exposed: an explicit, persisted answer to "which Notion workspace serves the
// OpenAI/Anthropic-compatible endpoints", the address of the MCP server this
// machine offers back to Notion, and a single live snapshot of what the proxy
// is doing right now. All three live here.
//
// Routing is persisted in config.yaml as:
//
//	server.api_routing:       auto | pinned
//	server.api_space:         space_id of the pinned workspace
//	server.api_space_name:    workspace name, dashboard display only
//	server.api_space_view_id: space view id belonging to that workspace
//	server.api_account:       email of the account that owns the workspace
//
// A pin targets a WORKSPACE, not an account. Notion meters AI usage per space
// and every inference request carries exactly one space_id, so "where do the
// messages go" is only meaningful at workspace granularity. One account can
// own several workspaces, which makes an account pin ambiguous. The owning
// account is therefore derived from the workspace and stored next to it, so a
// restart resolves the pin without waiting for a discovery pass.
//
// A pool account only remembers the single space that discovery picked as
// "best". When the pinned workspace is a different one, applyPinnedSpace
// rewrites the account's active space before the request is built, and it does
// so on every attempt because a background refresh can silently revert it.
//
// The MCP bridge is persisted as:
//
//	server.mcp_server_url: MCP endpoint Notion should call back into
//	server.mcp_token:      bearer token that endpoint expects
//	server.mcp_name:       display name of the integration inside Notion
//
// Keeping these on the server is what makes one-click binding possible: the
// dashboard does not have to know the bridge address, it just asks to attach
// "our" MCP server to a workspace. Values in config.yaml always win; the
// defaults below only fill in a fresh install.

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// APIRoutingAuto lets the pool choose the account.
	APIRoutingAuto = "auto"
	// APIRoutingPinned forces a single workspace for new conversations.
	APIRoutingPinned = "pinned"
)

const (
	// defaultMCPServerURL is the bridge this build ships with: the relay that
	// forwards Notion's MCP calls to the OpenCode worker.
	defaultMCPServerURL = "https://most.31.76.119.238.nip.io/mcp"
	// defaultMCPToken is the bearer that relay expects. Overridden by
	// config.yaml as soon as anything is saved from the dashboard.
	defaultMCPToken = "1b0ec90107299a29044ceb54e391ac56560f27cd76df58df"
	// defaultMCPName is what the integration is called inside Notion.
	defaultMCPName = "OpenCode Bridge"
)

var (
	apiRoutingMu          sync.RWMutex
	apiRoutingMode        = APIRoutingAuto
	apiRoutingEmail       string
	apiRoutingSpaceID     string
	apiRoutingSpaceName   string
	apiRoutingSpaceViewID string

	apiMCPMu    sync.RWMutex
	apiMCPURL   = defaultMCPServerURL
	apiMCPToken = defaultMCPToken
	apiMCPName  = defaultMCPName

	// apiTabStart backs the uptime figure shown in the API tab.
	apiTabStart = time.Now()
)

// APIRouting returns the routing mode and the email of the account that owns
// the pinned workspace.
func APIRouting() (mode string, email string) {
	apiRoutingMu.RLock()
	defer apiRoutingMu.RUnlock()
	return apiRoutingMode, apiRoutingEmail
}

// APIRoutingSpace returns the pinned workspace: its id, its display name and
// the space view id that belongs to it.
func APIRoutingSpace() (spaceID, spaceName, spaceViewID string) {
	apiRoutingMu.RLock()
	defer apiRoutingMu.RUnlock()
	return apiRoutingSpaceID, apiRoutingSpaceName, apiRoutingSpaceViewID
}

// APIMCP returns the MCP server the dashboard offers to attach to workspaces.
func APIMCP() (serverURL, token, name string) {
	apiMCPMu.RLock()
	defer apiMCPMu.RUnlock()
	return apiMCPURL, apiMCPToken, apiMCPName
}

// SetAPIMCP normalises and applies the bridge description in memory. An empty
// address or name falls back to the shipped default; an empty token does not,
// because clearing it is a legitimate way to describe a server without auth.
func SetAPIMCP(serverURL, token, name string) {
	serverURL = strings.TrimSpace(serverURL)
	if serverURL == "" {
		serverURL = defaultMCPServerURL
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = defaultMCPName
	}
	apiMCPMu.Lock()
	apiMCPURL = serverURL
	apiMCPToken = strings.TrimSpace(token)
	apiMCPName = name
	apiMCPMu.Unlock()
}

// SetAPIRouting normalises and applies a routing decision in memory. The
// workspace and account are kept even in auto mode so the dashboard can
// remember the last choice and pre-select it.
func SetAPIRouting(mode, email, spaceID, spaceName, spaceViewID string) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode != APIRoutingPinned {
		mode = APIRoutingAuto
	}
	apiRoutingMu.Lock()
	apiRoutingMode = mode
	apiRoutingEmail = strings.TrimSpace(email)
	apiRoutingSpaceID = strings.TrimSpace(spaceID)
	apiRoutingSpaceName = strings.TrimSpace(spaceName)
	apiRoutingSpaceViewID = strings.TrimSpace(spaceViewID)
	apiRoutingMu.Unlock()
}

// InitAPIRoutingFromConfig seeds the in-memory decision from config.yaml and
// normalises the config struct so a later persist writes clean values. The MCP
// bridge is seeded in the same pass: both are read from the same file at the
// same moment, and main.go already calls this once during startup.
func InitAPIRoutingFromConfig() {
	SetAPIRouting(
		AppConfig.Server.APIRouting,
		AppConfig.Server.APIAccount,
		AppConfig.Server.APISpace,
		AppConfig.Server.APISpaceName,
		AppConfig.Server.APISpaceView,
	)
	mode, email := APIRouting()
	spaceID, spaceName, spaceViewID := APIRoutingSpace()
	AppConfig.Server.APIRouting = mode
	AppConfig.Server.APIAccount = email
	AppConfig.Server.APISpace = spaceID
	AppConfig.Server.APISpaceName = spaceName
	AppConfig.Server.APISpaceView = spaceViewID
	switch {
	case mode == APIRoutingPinned && spaceID != "":
		log.Printf("[api] routing: pinned to workspace %s (account %s)", describeSpace(spaceName, spaceID), email)
	case mode == APIRoutingPinned && email != "":
		// Legacy config written before workspace pinning existed.
		log.Printf("[api] routing: pinned to account %s (no workspace recorded, pick one in the API tab)", email)
	default:
		log.Printf("[api] routing: auto (highest remaining quota first)")
	}
	initAPIMCPFromConfig()
}

// initAPIMCPFromConfig seeds the bridge description from config.yaml. The
// shipped token is only injected when the file describes no bridge at all: a
// config that names its own server but no token means "this server needs no
// auth", and silently attaching our bearer to it would be wrong.
func initAPIMCPFromConfig() {
	serverURL := strings.TrimSpace(AppConfig.Server.MCPServerURL)
	token := strings.TrimSpace(AppConfig.Server.MCPToken)
	name := strings.TrimSpace(AppConfig.Server.MCPName)
	if serverURL == "" && token == "" {
		token = defaultMCPToken
	}
	SetAPIMCP(serverURL, token, name)
	nextURL, nextToken, nextName := APIMCP()
	AppConfig.Server.MCPServerURL = nextURL
	AppConfig.Server.MCPToken = nextToken
	AppConfig.Server.MCPName = nextName
	log.Printf("[api] mcp bridge: %s as %q (token %s)", nextURL, nextName, describeSecret(nextToken))
}

// describeSecret keeps tokens out of the log while still saying whether one is
// configured at all - the single most common cause of a failed handshake.
func describeSecret(v string) string {
	if strings.TrimSpace(v) == "" {
		return "not set"
	}
	return "set"
}

// describeSpace renders a workspace for logs and for the dashboard's
// "effective" field: its name when known, a short id otherwise.
func describeSpace(name, id string) string {
	name = strings.TrimSpace(name)
	if name != "" {
		return name
	}
	id = strings.TrimSpace(id)
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// GetBySpaceID returns the pool account whose active workspace is spaceID.
func (p *AccountPool) GetBySpaceID(spaceID string) *Account {
	spaceID = strings.TrimSpace(spaceID)
	if p == nil || spaceID == "" {
		return nil
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	for _, acc := range p.accounts {
		if acc == nil {
			continue
		}
		acc.mu.RLock()
		match := strings.EqualFold(acc.SpaceID, spaceID)
		acc.mu.RUnlock()
		if match {
			return acc
		}
	}
	return nil
}

// applyPinnedSpace points the account at the pinned workspace. Accounts carry
// one active space; discovery picks it heuristically and a refresh can change
// it back, so the pin is re-applied on every request instead of once at save
// time. It is a no-op when the account already serves that workspace.
func applyPinnedSpace(acc *Account, spaceID, spaceName, spaceViewID string) {
	spaceID = strings.TrimSpace(spaceID)
	if acc == nil || spaceID == "" {
		return
	}
	acc.mu.Lock()
	changed := !strings.EqualFold(acc.SpaceID, spaceID)
	if changed {
		acc.SpaceID = spaceID
		if name := strings.TrimSpace(spaceName); name != "" {
			acc.SpaceName = name
		}
		if view := strings.TrimSpace(spaceViewID); view != "" {
			acc.SpaceViewID = view
		}
	}
	email := acc.UserEmail
	acc.mu.Unlock()
	if changed {
		log.Printf("[api] pinned workspace applied: %s now serves %s", email, describeSpace(spaceName, spaceID))
	}
}

// resolvePinnedAccount finds the account that can reach the pinned workspace:
// preferably the one already serving it, otherwise the recorded owner.
func resolvePinnedAccount(pool *AccountPool, spaceID, email string) *Account {
	if pool == nil {
		return nil
	}
	if acc := pool.GetBySpaceID(spaceID); acc != nil {
		return acc
	}
	if strings.TrimSpace(email) != "" {
		return pool.GetByEmail(email)
	}
	return nil
}

// pinnedAPIAccount returns the account an inference attempt must use, already
// switched to the pinned workspace, or nil when the pool should decide.
// exclude carries the accounts already tried in this request, so a failing pin
// degrades into normal failover instead of retrying a dead account forever.
func pinnedAPIAccount(pool *AccountPool, exclude map[*Account]bool) *Account {
	mode, email := APIRouting()
	if pool == nil || mode != APIRoutingPinned {
		return nil
	}
	spaceID, spaceName, spaceViewID := APIRoutingSpace()
	if spaceID == "" && email == "" {
		return nil
	}
	acc := resolvePinnedAccount(pool, spaceID, email)
	if acc == nil {
		return nil
	}
	if exclude != nil && exclude[acc] {
		return nil
	}
	applyPinnedSpace(acc, spaceID, spaceName, spaceViewID)
	return acc
}

// apiRoutingSnapshot describes the routing decision for the dashboard,
// including whether the pinned workspace actually resolves against the pool.
func apiRoutingSnapshot(pool *AccountPool) map[string]interface{} {
	mode, email := APIRouting()
	spaceID, spaceName, spaceViewID := APIRoutingSpace()
	snap := map[string]interface{}{
		"mode":            mode,
		"email":           email,
		"space_id":        spaceID,
		"space_name":      spaceName,
		"space_view_id":   spaceViewID,
		"pin_resolved":    false,
		"effective":       "",
		"effective_email": "",
	}
	if mode != APIRoutingPinned {
		return snap
	}
	if spaceID == "" {
		snap["warning"] = "no workspace is selected; requests fall back to automatic selection"
		return snap
	}
	acc := resolvePinnedAccount(pool, spaceID, email)
	if acc == nil {
		snap["warning"] = "the account owning this workspace is not in the pool; requests fall back to automatic selection"
		return snap
	}
	snap["pin_resolved"] = true
	snap["effective"] = describeSpace(spaceName, spaceID)
	snap["effective_email"] = acc.UserEmail
	return snap
}

// apiMCPSnapshot describes the bridge for the dashboard. The token travels to
// the browser because the connect endpoint takes it as a parameter, exactly
// like the manual "add MCP server" form on the workspace tab; the dashboard is
// already password-gated and already handles far more sensitive account
// tokens.
func apiMCPSnapshot() map[string]interface{} {
	serverURL, token, name := APIMCP()
	return map[string]interface{}{
		"server_url": serverURL,
		"token":      token,
		"name":       name,
		"token_set":  strings.TrimSpace(token) != "",
	}
}

// apiConfigPayload is the shared GET/PUT response for the API tab.
func apiConfigPayload(pool *AccountPool) map[string]interface{} {
	return map[string]interface{}{
		"api_key":       AppConfig.Server.ApiKey,
		"port":          AppConfig.Server.Port,
		"default_model": AppConfig.Proxy.DefaultModel,
		"routing":       apiRoutingSnapshot(pool),
		"mcp":           apiMCPSnapshot(),
		"accounts":      pool.GetAccountDetails(),
	}
}

// HandleAdminAPIConfig handles GET (read) and PUT (update) for the API tab:
// the endpoint key, the default model, the workspace routing decision and the
// MCP bridge description.
func HandleAdminAPIConfig(pool *AccountPool, configPath string, auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if auth.HasAdminPassword() && !auth.ValidateSession(r) {
			http.Error(w, `{"error":"unauthorized, dashboard login required"}`, http.StatusUnauthorized)
			return
		}

		switch r.Method {
		case "GET":
			json.NewEncoder(w).Encode(apiConfigPayload(pool))

		case "PUT":
			var body struct {
				APIKey         *string `json:"api_key"`
				APIRouting     *string `json:"api_routing"`
				APIAccount     *string `json:"api_account"`
				APISpace       *string `json:"api_space"`
				APISpaceName   *string `json:"api_space_name"`
				APISpaceViewID *string `json:"api_space_view_id"`
				MCPServerURL   *string `json:"mcp_server_url"`
				MCPToken       *string `json:"mcp_token"`
				MCPName        *string `json:"mcp_name"`
				DefaultModel   *string `json:"default_model"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
				return
			}

			changed := false

			if body.APIKey != nil {
				next := strings.TrimSpace(*body.APIKey)
				if next == "" {
					http.Error(w, `{"error":"api_key cannot be empty"}`, http.StatusBadRequest)
					return
				}
				if next != AppConfig.Server.ApiKey {
					AppConfig.Server.ApiKey = next
					changed = true
					log.Printf("[api] api_key rotated (%d chars)", len(next))
				}
			}

			routingTouched := body.APIRouting != nil ||
				body.APIAccount != nil ||
				body.APISpace != nil ||
				body.APISpaceName != nil ||
				body.APISpaceViewID != nil

			if routingTouched {
				mode, email := APIRouting()
				spaceID, spaceName, spaceViewID := APIRoutingSpace()
				if body.APIRouting != nil {
					mode = *body.APIRouting
				}
				if body.APIAccount != nil {
					email = strings.TrimSpace(*body.APIAccount)
				}
				if body.APISpace != nil {
					spaceID = strings.TrimSpace(*body.APISpace)
				}
				if body.APISpaceName != nil {
					spaceName = strings.TrimSpace(*body.APISpaceName)
				}
				if body.APISpaceViewID != nil {
					spaceViewID = strings.TrimSpace(*body.APISpaceViewID)
				}

				if strings.ToLower(strings.TrimSpace(mode)) == APIRoutingPinned {
					if spaceID == "" {
						http.Error(w, `{"error":"pinned routing requires api_space"}`, http.StatusBadRequest)
						return
					}
					owner := resolvePinnedAccount(pool, spaceID, email)
					if owner == nil {
						http.Error(w, `{"error":"the account owning that workspace is not in the pool"}`, http.StatusBadRequest)
						return
					}
					if email == "" {
						email = owner.UserEmail
					}
				}

				SetAPIRouting(mode, email, spaceID, spaceName, spaceViewID)
				nextMode, nextEmail := APIRouting()
				nextSpace, nextSpaceName, nextSpaceView := APIRoutingSpace()
				AppConfig.Server.APIRouting = nextMode
				AppConfig.Server.APIAccount = nextEmail
				AppConfig.Server.APISpace = nextSpace
				AppConfig.Server.APISpaceName = nextSpaceName
				AppConfig.Server.APISpaceView = nextSpaceView
				changed = true
				if nextMode == APIRoutingPinned {
					log.Printf("[api] routing -> pinned workspace %s (account %s)", describeSpace(nextSpaceName, nextSpace), nextEmail)
				} else {
					log.Printf("[api] routing -> auto")
				}
			}

			if body.MCPServerURL != nil || body.MCPToken != nil || body.MCPName != nil {
				serverURL, token, name := APIMCP()
				if body.MCPServerURL != nil {
					serverURL = strings.TrimSpace(*body.MCPServerURL)
				}
				if body.MCPToken != nil {
					token = strings.TrimSpace(*body.MCPToken)
				}
				if body.MCPName != nil {
					name = strings.TrimSpace(*body.MCPName)
				}
				if serverURL != "" {
					low := strings.ToLower(serverURL)
					if !strings.HasPrefix(low, "http://") && !strings.HasPrefix(low, "https://") {
						http.Error(w, `{"error":"mcp_server_url must start with http:// or https://"}`, http.StatusBadRequest)
						return
					}
				}
				SetAPIMCP(serverURL, token, name)
				nextURL, nextToken, nextName := APIMCP()
				AppConfig.Server.MCPServerURL = nextURL
				AppConfig.Server.MCPToken = nextToken
				AppConfig.Server.MCPName = nextName
				changed = true
				log.Printf("[api] mcp bridge -> %s as %q (token %s)", nextURL, nextName, describeSecret(nextToken))
			}

			if body.DefaultModel != nil {
				next := strings.TrimSpace(*body.DefaultModel)
				if next != "" && next != AppConfig.Proxy.DefaultModel {
					AppConfig.Proxy.DefaultModel = next
					changed = true
					log.Printf("[api] default_model -> %s", next)
				}
			}

			if changed && configPath != "" {
				persistSearchSettings(configPath)
			}

			json.NewEncoder(w).Encode(apiConfigPayload(pool))

		default:
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		}
	}
}

// HandleAdminAPIStatus returns one live snapshot for the API tab: endpoint
// configuration, the effective routing decision, and per-account quota.
func HandleAdminAPIStatus(pool *AccountPool, auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if auth.HasAdminPassword() && !auth.ValidateSession(r) {
			http.Error(w, `{"error":"unauthorized, dashboard login required"}`, http.StatusUnauthorized)
			return
		}
		if r.Method != "GET" {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}

		json.NewEncoder(w).Encode(map[string]interface{}{
			"server": map[string]interface{}{
				"port":           AppConfig.Server.Port,
				"api_key":        AppConfig.Server.ApiKey,
				"default_model":  AppConfig.Proxy.DefaultModel,
				"debug_logging":  AppConfig.Server.DebugLogging,
				"notion_proxy":   AppConfig.NotionProxyURL(),
				"uptime_seconds": int(time.Since(apiTabStart).Seconds()),
			},
			"routing":         apiRoutingSnapshot(pool),
			"mcp":             apiMCPSnapshot(),
			"accounts":        pool.GetAccountDetails(),
			"quota":           pool.GetQuotaSummary(),
			"refresh":         pool.GetRefreshStatus(),
			"model_map":       SnapshotModelMap(),
			"model_count":     len(pool.AllModels()),
			"account_count":   pool.Count(),
			"available_count": pool.AvailableCount(),
			"generated_at":    time.Now().UTC().Format(time.RFC3339),
		})
	}
}
