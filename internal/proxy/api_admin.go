package proxy

// Test/MVP dashboard API configuration for AIRI.
//
// This deliberately keeps the existing single server.api_key model so the
// end-to-end route can be proven before adding a multi-key store. The key,
// workspace pin and model are editable only from the administrator dashboard
// and are persisted to config.yaml.

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
)

const AIRIModelAlias = "notion-ai"

var apiRuntimeConfigMu sync.RWMutex

// CurrentAPIKey is read by the HTTP auth middleware on every request. Reading
// it dynamically makes a key rotation effective immediately, without restart.
func CurrentAPIKey() string {
	apiRuntimeConfigMu.RLock()
	defer apiRuntimeConfigMu.RUnlock()
	if AppConfig == nil {
		return ""
	}
	return strings.TrimSpace(AppConfig.Server.ApiKey)
}

func setCurrentAPIKey(value string) {
	apiRuntimeConfigMu.Lock()
	defer apiRuntimeConfigMu.Unlock()
	if AppConfig != nil {
		AppConfig.Server.ApiKey = strings.TrimSpace(value)
	}
}

// APIDefaultModel is the real Notion model represented by the stable
// "notion-ai" model alias exposed to AIRI.
func APIDefaultModel() string {
	apiRuntimeConfigMu.RLock()
	defer apiRuntimeConfigMu.RUnlock()
	if AppConfig == nil {
		return ""
	}
	return strings.TrimSpace(AppConfig.Proxy.DefaultModel)
}

func setAPIDefaultModel(value string) {
	apiRuntimeConfigMu.Lock()
	defer apiRuntimeConfigMu.Unlock()
	if AppConfig != nil {
		AppConfig.Proxy.DefaultModel = strings.TrimSpace(value)
	}
}

func resolveAPIModel(requested string) string {
	requested = strings.TrimSpace(requested)
	if requested == "" || strings.EqualFold(requested, AIRIModelAlias) {
		return APIDefaultModel()
	}
	return requested
}

func apiKeyPreview(key string) string {
	key = strings.TrimSpace(key)
	if len(key) <= 10 {
		return key
	}
	return key[:7] + "..." + key[len(key)-4:]
}

func apiRoutingSnapshot(pool *AccountPool) map[string]interface{} {
	mode, email := APIRouting()
	spaceID, spaceName, spaceViewID := APIRoutingSpace()
	snapshot := map[string]interface{}{
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
		return snapshot
	}
	if spaceID == "" {
		snapshot["warning"] = "no workspace is selected"
		return snapshot
	}
	account := resolvePinnedAccount(pool, spaceID, email)
	if account == nil {
		snapshot["warning"] = "the selected workspace account is not in the pool"
		return snapshot
	}
	snapshot["pin_resolved"] = true
	snapshot["effective"] = describeSpace(spaceName, spaceID)
	snapshot["effective_email"] = account.UserEmail
	return snapshot
}

func apiAvailableModels(pool *AccountPool) []string {
	seen := map[string]bool{}
	for name := range SnapshotModelMap() {
		name = strings.TrimSpace(name)
		if name != "" {
			seen[name] = true
		}
	}
	if pool != nil {
		for _, entry := range pool.AllModels() {
			if id := strings.TrimSpace(publicModelID(entry)); id != "" {
				seen[id] = true
			}
		}
	}
	models := make([]string, 0, len(seen))
	for model := range seen {
		models = append(models, model)
	}
	sort.Strings(models)
	return models
}

func apiConfigPayload(pool *AccountPool) map[string]interface{} {
	key := CurrentAPIKey()
	return map[string]interface{}{
		"api_key":         key,
		"api_key_preview": apiKeyPreview(key),
		"base_path":       "/v1/airi/",
		"model_alias":     AIRIModelAlias,
		"default_model":   APIDefaultModel(),
		"models":          apiAvailableModels(pool),
		"routing":         apiRoutingSnapshot(pool),
	}
}

func writeAPIAdminError(w http.ResponseWriter, status int, message string) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

// HandleAdminAPIConfig serves the administrator-only "API keys" tab.
// PUT supports an atomic MVP update of the key, model and workspace pin.
func HandleAdminAPIConfig(pool *AccountPool, configPath string, auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if auth != nil && auth.HasAdminPassword() && !auth.ValidateSession(r) {
			writeAPIAdminError(w, http.StatusUnauthorized, "unauthorized, dashboard login required")
			return
		}

		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(apiConfigPayload(pool))
			return

		case http.MethodPut:
			var body struct {
				RotateKey      bool    `json:"rotate_key"`
				APIKey         *string `json:"api_key"`
				DefaultModel   *string `json:"default_model"`
				APIRouting     *string `json:"api_routing"`
				APIAccount     *string `json:"api_account"`
				APISpace       *string `json:"api_space"`
				APISpaceName   *string `json:"api_space_name"`
				APISpaceViewID *string `json:"api_space_view_id"`
			}
			r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				writeAPIAdminError(w, http.StatusBadRequest, "invalid request body")
				return
			}

			// Validate the full update before mutating runtime state. A bad
			// workspace selection must never leave a freshly rotated key active.
			if body.APIKey != nil && !body.RotateKey && strings.TrimSpace(*body.APIKey) == "" {
				writeAPIAdminError(w, http.StatusBadRequest, "api_key cannot be empty")
				return
			}
			if body.DefaultModel != nil && strings.TrimSpace(*body.DefaultModel) == "" {
				writeAPIAdminError(w, http.StatusBadRequest, "default_model cannot be empty")
				return
			}
			routingTouched := body.APIRouting != nil || body.APIAccount != nil ||
				body.APISpace != nil || body.APISpaceName != nil || body.APISpaceViewID != nil
			if routingTouched {
				mode, email := APIRouting()
				spaceID, _, _ := APIRoutingSpace()
				if body.APIRouting != nil {
					mode = strings.TrimSpace(*body.APIRouting)
				}
				if body.APIAccount != nil {
					email = strings.TrimSpace(*body.APIAccount)
				}
				if body.APISpace != nil {
					spaceID = strings.TrimSpace(*body.APISpace)
				}
				if strings.EqualFold(mode, APIRoutingPinned) {
					if spaceID == "" || email == "" {
						writeAPIAdminError(w, http.StatusBadRequest, "pinned routing requires api_space and api_account")
						return
					}
					if pool == nil || resolvePinnedAccount(pool, spaceID, email) == nil {
						writeAPIAdminError(w, http.StatusBadRequest, "the selected workspace account is not in the pool")
						return
					}
				}
			}

			changed := false
			if body.RotateKey {
				next := GenerateApiKey()
				setCurrentAPIKey(next)
				changed = true
				log.Printf("[api] AIRI API key rotated (%s)", apiKeyPreview(next))
			} else if body.APIKey != nil {
				next := strings.TrimSpace(*body.APIKey)
				if next == "" {
					writeAPIAdminError(w, http.StatusBadRequest, "api_key cannot be empty")
					return
				}
				if next != CurrentAPIKey() {
					setCurrentAPIKey(next)
					changed = true
					log.Printf("[api] AIRI API key changed (%s)", apiKeyPreview(next))
				}
			}

			if body.DefaultModel != nil {
				next := strings.TrimSpace(*body.DefaultModel)
				if next == "" {
					writeAPIAdminError(w, http.StatusBadRequest, "default_model cannot be empty")
					return
				}
				if next != APIDefaultModel() {
					setAPIDefaultModel(next)
					changed = true
					log.Printf("[api] AIRI default model -> %s", next)
				}
			}

			if routingTouched {
				mode, email := APIRouting()
				spaceID, spaceName, spaceViewID := APIRoutingSpace()
				if body.APIRouting != nil {
					mode = strings.TrimSpace(*body.APIRouting)
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

				if strings.EqualFold(mode, APIRoutingPinned) {
					if spaceID == "" || email == "" {
						writeAPIAdminError(w, http.StatusBadRequest, "pinned routing requires api_space and api_account")
						return
					}
					if resolvePinnedAccount(pool, spaceID, email) == nil {
						writeAPIAdminError(w, http.StatusBadRequest, "the selected workspace account is not in the pool")
						return
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
				log.Printf("[api] AIRI routing -> %s (%s)", nextMode, describeSpace(nextSpaceName, nextSpace))
			}

			if changed && configPath != "" {
				persistSearchSettings(configPath)
			}
			_ = json.NewEncoder(w).Encode(apiConfigPayload(pool))
			return

		default:
			w.Header().Set("Allow", "GET, PUT")
			writeAPIAdminError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	}
}
