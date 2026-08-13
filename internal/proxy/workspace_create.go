package proxy

// Bulk workspace creation for a single account, behind the dashboard's
// "create workspace" button.
//
// Notion's /createSpace call only registers the space itself. The space_view
// record that links it into the sidebar is invented client-side and posted
// separately through saveTransactionsMain; running just the first call leaves
// a "ghost space" that never shows up in the UI. Both requests therefore
// always run as a pair here, mirroring the registration flow in
// internal/msalogin/notion.go.

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

const (
	// maxWorkspacesPerRequest caps one dashboard click so a stray number in the
	// count box cannot fire an unbounded burst of createSpace calls.
	maxWorkspacesPerRequest = 25

	// workspaceCreateDelay spaces consecutive creations out a little. A tight
	// zero-gap loop is exactly the pattern Notion's anti-spam heuristics react
	// to, and the first symptom is a silently missing space_view link.
	workspaceCreateDelay = 700 * time.Millisecond
)

// Word lists for randomWorkspaceName. ASCII only, so generated names pass
// Notion's own name validation everywhere.
var (
	wsNameAdjectives = []string{
		"Bright", "Calm", "Clever", "Cosmic", "Crisp", "Deep", "Eager", "Fresh",
		"Gentle", "Golden", "Happy", "Ivory", "Jolly", "Keen", "Lucky", "Merry",
		"Neat", "Noble", "Polar", "Quiet", "Rapid", "Royal", "Sharp", "Silent",
		"Smart", "Solar", "Swift", "Urban", "Vivid", "Warm", "Wild", "Young",
	}
	wsNameNouns = []string{
		"Atlas", "Beacon", "Canyon", "Cedar", "Comet", "Delta", "Ember", "Falcon",
		"Forest", "Garden", "Harbor", "Island", "Jungle", "Lagoon", "Meadow",
		"Nebula", "Ocean", "Orbit", "Pebble", "Quartz", "River", "Summit",
		"Thunder", "Tundra", "Valley", "Voyage", "Willow", "Zenith",
	}
)

// CreatedWorkspace is one freshly created space, shaped like the entries the
// dashboard already renders from /admin/discover.
type CreatedWorkspace struct {
	SpaceID     string `json:"space_id"`
	SpaceViewID string `json:"space_view_id"`
	Name        string `json:"name"`
}

// CreateWorkspacesResponse is the /admin/workspaces/create payload. Created
// and Errors are both filled in on a partial success, so the UI can report
// "3 of 5 created" instead of an all-or-nothing failure.
type CreateWorkspacesResponse struct {
	UserID    string             `json:"user_id"`
	Requested int                `json:"requested"`
	Created   []CreatedWorkspace `json:"created"`
	Errors    []string           `json:"errors,omitempty"`
	Error     string             `json:"error,omitempty"`
}

// randomWorkspaceName builds names like "Swift Harbor 482".
func randomWorkspaceName() string {
	return fmt.Sprintf("%s %s %d",
		wsNameAdjectives[wsRandIndex(len(wsNameAdjectives))],
		wsNameNouns[wsRandIndex(len(wsNameNouns))],
		100+wsRandIndex(900),
	)
}

// wsRandIndex returns a random index in [0,n). The modulo bias is irrelevant
// for cosmetic names, and crypto/rand keeps this independent of the shared
// math/rand state used elsewhere in the package.
func wsRandIndex(n int) int {
	if n <= 0 {
		return 0
	}
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return int(time.Now().UnixNano() % int64(n))
	}
	v := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
	return int(v % uint32(n))
}

// wsNewUUID returns an RFC-4122 v4 UUID, the id format Notion expects for
// client-generated space_view records and device ids.
func wsNewUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		now := uint64(time.Now().UnixNano())
		for i := 0; i < 8; i++ {
			b[i] = byte(now >> (8 * uint(i)))
			b[8+i] = byte(now >> (8 * uint(7-i)))
		}
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// wsSetNotionHeaders applies the same browser-shaped header set the other
// workspace calls use (see workspace.go). spaceID is omitted for createSpace,
// which runs before any space exists.
func wsSetNotionHeaders(req *http.Request, tokenV2, userID, spaceID string) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Cookie", "token_v2="+tokenV2)
	req.Header.Set("User-Agent", AppConfig.Browser.UserAgent)
	req.Header.Set("notion-client-version", DefaultClientVersion)
	if userID != "" {
		req.Header.Set("x-notion-active-user-header", userID)
	}
	if spaceID != "" {
		req.Header.Set("x-notion-space-id", spaceID)
	}
}

// wsFetchUserID resolves the signed-in user id for a token. createSpace needs
// it for the active-user header, and the follow-up transaction writes into
// that user's user_root.
func wsFetchUserID(tokenV2 string) (string, error) {
	client := getChromeHTTPClient(AppConfig.APITimeoutDuration())
	req, err := http.NewRequest("POST", NotionAPIBase+"/loadUserContent", bytes.NewReader([]byte("{}")))
	if err != nil {
		return "", fmt.Errorf("create loadUserContent request: %w", err)
	}
	wsSetNotionHeaders(req, tokenV2, "", "")

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("loadUserContent failed: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("loadUserContent error %d: %s", resp.StatusCode, truncate(string(body), 200))
	}

	var data struct {
		RecordMap struct {
			NotionUser map[string]json.RawMessage `json:"notion_user"`
		} `json:"recordMap"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return "", fmt.Errorf("parse loadUserContent: %w", err)
	}
	for id := range data.RecordMap.NotionUser {
		if strings.TrimSpace(id) != "" {
			return id, nil
		}
	}
	return "", fmt.Errorf("no user found for this token")
}

// wsCreateSpace creates one workspace and links it into the account sidebar.
func wsCreateSpace(tokenV2, userID, name string) (*CreatedWorkspace, error) {
	client := getChromeHTTPClient(AppConfig.APITimeoutDuration())

	reqBody, err := json.Marshal(map[string]interface{}{
		"name":           name,
		"icon":           "\U0001F3E0",
		"planType":       "personal",
		"planSelection":  "personal",
		"initialPersona": "unfilled",
		"deviceId":       wsNewUUID(),
		"deviceType":     "web-desktop",
		"source":         "sidebar_switcher",
	})
	if err != nil {
		return nil, fmt.Errorf("encode createSpace body: %w", err)
	}

	req, err := http.NewRequest("POST", NotionAPIBase+"/createSpace", bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("create createSpace request: %w", err)
	}
	wsSetNotionHeaders(req, tokenV2, userID, "")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("createSpace failed: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("createSpace error %d: %s", resp.StatusCode, truncate(string(body), 200))
	}

	var csResp struct {
		SpaceID string `json:"spaceId"`
	}
	if err := json.Unmarshal(body, &csResp); err != nil {
		return nil, fmt.Errorf("parse createSpace: %w", err)
	}
	if strings.TrimSpace(csResp.SpaceID) == "" {
		return nil, fmt.Errorf("createSpace returned no spaceId")
	}

	viewID := wsNewUUID()
	if err := wsAttachSpaceView(tokenV2, userID, csResp.SpaceID, viewID); err != nil {
		return nil, fmt.Errorf("space %s created but not linked: %w", truncate(csResp.SpaceID, 8), err)
	}

	log.Printf("[workspace] created space=%s view=%s name=%q", truncate(csResp.SpaceID, 8), truncate(viewID, 8), name)
	return &CreatedWorkspace{SpaceID: csResp.SpaceID, SpaceViewID: viewID, Name: name}, nil
}

// wsAttachSpaceView posts the saveTransactionsMain call that links a freshly
// created space into user_root. Keep the operation order identical (set
// space_view -> listAfter space_views -> keyedObjectListAfter
// space_view_pointers): Notion processes them in order and the latter two
// depend on the first.
func wsAttachSpaceView(tokenV2, userID, spaceID, viewID string) error {
	if strings.TrimSpace(userID) == "" {
		return fmt.Errorf("no user id")
	}
	client := getChromeHTTPClient(AppConfig.APITimeoutDuration())
	now := time.Now().UnixMilli()

	tx := map[string]interface{}{
		"requestId": wsNewUUID(),
		"transactions": []map[string]interface{}{
			{
				"id":      wsNewUUID(),
				"spaceId": spaceID,
				"debug":   map[string]interface{}{"userAction": "spaceActions.createSpace"},
				"operations": []map[string]interface{}{
					{
						"pointer": map[string]interface{}{"table": "space_view", "id": viewID, "spaceId": spaceID},
						"path":    []interface{}{},
						"command": "set",
						"args": map[string]interface{}{
							"id":                      viewID,
							"version":                 1,
							"space_id":                spaceID,
							"notify_mobile":           true,
							"notify_desktop":          true,
							"notify_email":            true,
							"parent_id":               userID,
							"parent_table":            "user_root",
							"alive":                   true,
							"first_joined_space_time": now,
							"joined":                  true,
							"settings": map[string]interface{}{
								"notify_email_digest":      true,
								"notify_home_digest_email": true,
							},
						},
					},
					{
						"pointer": map[string]interface{}{"table": "user_root", "id": userID},
						"path":    []interface{}{"space_views"},
						"command": "listAfter",
						"args":    map[string]interface{}{"id": viewID},
					},
					{
						"pointer": map[string]interface{}{"table": "user_root", "id": userID},
						"path":    []interface{}{"space_view_pointers"},
						"command": "keyedObjectListAfter",
						"args": map[string]interface{}{
							"value": map[string]interface{}{"table": "space_view", "id": viewID, "spaceId": spaceID},
						},
					},
				},
			},
		},
	}

	reqBody, err := json.Marshal(tx)
	if err != nil {
		return fmt.Errorf("encode transaction: %w", err)
	}
	req, err := http.NewRequest("POST", NotionAPIBase+"/saveTransactionsMain", bytes.NewReader(reqBody))
	if err != nil {
		return fmt.Errorf("create saveTransactionsMain request: %w", err)
	}
	wsSetNotionHeaders(req, tokenV2, userID, spaceID)

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("saveTransactionsMain failed: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("saveTransactionsMain error %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return nil
}

// HandleCreateWorkspaces creates N workspaces with random names for one
// account token. Creation is sequential on purpose: Notion links each new
// space into the same user_root record, and parallel writes there are what
// produce spaces that never appear in the sidebar.
func HandleCreateWorkspaces(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if r.Method != http.MethodPost {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		if auth.HasAdminPassword() && !auth.ValidateSession(r) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}

		var body struct {
			TokenV2 string `json:"token_v2"`
			UserID  string `json:"user_id"`
			Count   int    `json:"count"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		tokenV2 := strings.TrimSpace(body.TokenV2)
		if tokenV2 == "" {
			http.Error(w, `{"error":"token_v2 is required"}`, http.StatusBadRequest)
			return
		}

		count := body.Count
		if count < 1 {
			count = 1
		}
		if count > maxWorkspacesPerRequest {
			count = maxWorkspacesPerRequest
		}

		userID := strings.TrimSpace(body.UserID)
		if userID == "" {
			resolved, err := wsFetchUserID(tokenV2)
			if err != nil {
				log.Printf("[workspace] create: cannot resolve user: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
				return
			}
			userID = resolved
		}

		out := CreateWorkspacesResponse{
			UserID:    userID,
			Requested: count,
			Created:   []CreatedWorkspace{},
		}
		for i := 0; i < count; i++ {
			if i > 0 {
				time.Sleep(workspaceCreateDelay)
			}
			space, err := wsCreateSpace(tokenV2, userID, randomWorkspaceName())
			if err != nil {
				log.Printf("[workspace] create %d/%d failed: %v", i+1, count, err)
				out.Errors = append(out.Errors, err.Error())
				continue
			}
			out.Created = append(out.Created, *space)
		}

		log.Printf("[workspace] created %d/%d workspace(s) for user %s", len(out.Created), count, truncate(userID, 8))

		// Nothing came through at all -> surface it as a failure so the UI shows
		// the reason instead of a silent "0 created".
		if len(out.Created) == 0 && len(out.Errors) > 0 {
			out.Error = out.Errors[0]
			w.WriteHeader(http.StatusBadGateway)
		}
		if err := json.NewEncoder(w).Encode(out); err != nil {
			log.Printf("[workspace] encode create response failed: %v", err)
		}
	}
}
