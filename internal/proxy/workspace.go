package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
)

// WorkspaceInfo holds details about a single Notion workspace
type WorkspaceInfo struct {
	SpaceID      string `json:"space_id"`
	SpaceViewID  string `json:"space_view_id"`
	Name         string `json:"name"`
	Icon         string `json:"icon"`
	PlanType     string `json:"plan_type"`
	PlanName     string `json:"plan_name"`
	Membership   string `json:"membership"`
	Domain       string `json:"domain"`
	Region       string `json:"region"`
	Cell         string `json:"cell"`
	IsSubscribed bool   `json:"is_subscribed"`
}

// AccountWorkspaces holds a user's account info plus all their workspaces
type AccountWorkspaces struct {
	UserID    string          `json:"user_id"`
	UserName  string          `json:"user_name"`
	UserEmail string          `json:"user_email"`
	TokenV2   string          `json:"token_v2"`
	Spaces    []WorkspaceInfo `json:"spaces"`
}

// DiscoverWorkspacesFromToken discovers ALL workspaces for the account.
//
// Step 1: loadUserContent gives every space's real name, icon and domain.
// Step 2: the space record's plan_type is only the workspace CATEGORY
//
//	("team" = multiplayer workspace, "personal" = single-player) and does NOT
//	reflect the paid subscription tier, so every card showed "Team". To get
//	the real tier (Free / Plus / Business / Enterprise) we call
//	/api/v3/getSubscriptionData for each space and use that instead.
func DiscoverWorkspacesFromToken(tokenV2 string) (*AccountWorkspaces, error) {
	client := getChromeHTTPClient(AppConfig.APITimeoutDuration())

	req, err := http.NewRequest("POST", NotionAPIBase+"/loadUserContent", bytes.NewReader([]byte("{}")))
	if err != nil {
		return nil, fmt.Errorf("create loadUserContent request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Cookie", "token_v2="+tokenV2)
	req.Header.Set("User-Agent", AppConfig.Browser.UserAgent)

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("loadUserContent failed: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("loadUserContent error %d: %s", resp.StatusCode, truncate(string(body), 300))
	}

	var userData struct {
		RecordMap struct {
			NotionUser map[string]json.RawMessage `json:"notion_user"`
			UserRoot   map[string]json.RawMessage `json:"user_root"`
			Space      map[string]json.RawMessage `json:"space"`
		} `json:"recordMap"`
	}
	if err := json.Unmarshal(body, &userData); err != nil {
		return nil, fmt.Errorf("parse loadUserContent: %w", err)
	}

	// Signed-in user identity.
	var userID, userName, userEmail string
	for id, raw := range userData.RecordMap.NotionUser {
		userID = id
		var u struct {
			Value struct {
				Value *struct {
					Name  string `json:"name"`
					Email string `json:"email"`
				} `json:"value"`
				Name  string `json:"name"`
				Email string `json:"email"`
			} `json:"value"`
		}
		if err := json.Unmarshal(raw, &u); err == nil {
			if u.Value.Value != nil {
				userName = u.Value.Value.Name
				userEmail = u.Value.Value.Email
			} else {
				userName = u.Value.Name
				userEmail = u.Value.Email
			}
		}
		break
	}
	if userID == "" {
		return nil, fmt.Errorf("no user found in loadUserContent response")
	}

	type spaceViewPointer struct {
		SpaceID string `json:"spaceId"`
		ID      string `json:"id"`
	}
	var pointers []spaceViewPointer
	if raw, ok := userData.RecordMap.UserRoot[userID]; ok {
		var ur struct {
			Value struct {
				Value *struct {
					SpaceViewPointers []spaceViewPointer `json:"space_view_pointers"`
				} `json:"value"`
				SpaceViewPointers []spaceViewPointer `json:"space_view_pointers"`
			} `json:"value"`
		}
		if err := json.Unmarshal(raw, &ur); err == nil {
			if ur.Value.Value != nil {
				pointers = ur.Value.Value.SpaceViewPointers
			} else {
				pointers = ur.Value.SpaceViewPointers
			}
		}
	}

	parseSpace := func(raw json.RawMessage) (id, name, icon, plan, domain string) {
		var s struct {
			Value struct {
				Value *struct {
					ID       string `json:"id"`
					Name     string `json:"name"`
					Icon     string `json:"icon"`
					PlanType string `json:"plan_type"`
					Domain   string `json:"domain"`
				} `json:"value"`
				ID       string `json:"id"`
				Name     string `json:"name"`
				Icon     string `json:"icon"`
				PlanType string `json:"plan_type"`
				Domain   string `json:"domain"`
			} `json:"value"`
		}
		if err := json.Unmarshal(raw, &s); err != nil {
			return
		}
		if s.Value.Value != nil {
			return s.Value.Value.ID, s.Value.Value.Name, s.Value.Value.Icon, s.Value.Value.PlanType, s.Value.Value.Domain
		}
		return s.Value.ID, s.Value.Name, s.Value.Icon, s.Value.PlanType, s.Value.Domain
	}

	spaces := make([]WorkspaceInfo, 0, len(pointers))
	seen := make(map[string]bool)
	addSpace := func(spaceID, viewID string, raw json.RawMessage) {
		id, name, icon, plan, domain := parseSpace(raw)
		if id == "" {
			id = spaceID
		}
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		if name == "" {
			name = "Workspace"
		}
		spaces = append(spaces, WorkspaceInfo{
			SpaceID:     id,
			SpaceViewID: viewID,
			Name:        name,
			Icon:        icon,
			PlanType:    plan,
			Domain:      domain,
			Membership:  "member",
		})
	}

	for _, p := range pointers {
		if raw, ok := userData.RecordMap.Space[p.SpaceID]; ok {
			addSpace(p.SpaceID, p.ID, raw)
		}
	}
	for sid, raw := range userData.RecordMap.Space {
		if !seen[sid] {
			addSpace(sid, "", raw)
		}
	}

	if len(spaces) == 0 {
		return nil, fmt.Errorf("no workspaces found for this account")
	}

	// Enrich each space with its REAL subscription tier (concurrently).
	var wg sync.WaitGroup
	for i := range spaces {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			planType, planName := fetchSpaceSubscription(tokenV2, userID, spaces[idx].SpaceID)
			if planType != "" {
				spaces[idx].PlanType = planType
			}
			if planName != "" {
				spaces[idx].PlanName = planName
			}
			pt := strings.ToLower(strings.TrimSpace(spaces[idx].PlanType))
			// "team" alone is the workspace category, not a paid tier, so it does
			// not count as subscribed unless getSubscriptionData said otherwise.
			spaces[idx].IsSubscribed = pt != "" && pt != "free" && pt != "team" && pt != "personal"
		}(i)
	}
	wg.Wait()

	// Anything we still couldn't classify falls back to Free for display.
	for i := range spaces {
		if strings.TrimSpace(spaces[i].PlanType) == "" || strings.EqualFold(spaces[i].PlanType, "team") {
			if !spaces[i].IsSubscribed {
				spaces[i].PlanType = "free"
			}
		}
	}

	log.Printf("[workspace] found %d workspace(s) for %s", len(spaces), userEmail)

	return &AccountWorkspaces{
		UserID:    userID,
		UserName:  userName,
		UserEmail: userEmail,
		TokenV2:   tokenV2,
		Spaces:    spaces,
	}, nil
}

var planKeywords = map[string]bool{
	"free": true, "plus": true, "pro": true, "personal_pro": true,
	"team": true, "business": true, "enterprise": true,
	"education": true, "personal": true,
}

func isPlanKeyword(s string) bool {
	return planKeywords[strings.ToLower(strings.TrimSpace(s))]
}

// fetchSpaceSubscription queries /api/v3/getSubscriptionData for a single space
// and returns the real plan tier (e.g. "free", "business", "enterprise") plus an
// optional human-readable plan name when Notion provides one. Returns empty
// strings on any failure so the caller can fall back gracefully.
func fetchSpaceSubscription(tokenV2, userID, spaceID string) (planType, planName string) {
	if spaceID == "" {
		return "", ""
	}
	client := getChromeHTTPClient(AppConfig.APITimeoutDuration())
	reqBody, _ := json.Marshal(map[string]string{"spaceId": spaceID})
	req, err := http.NewRequest("POST", NotionAPIBase+"/getSubscriptionData", bytes.NewReader(reqBody))
	if err != nil {
		return "", ""
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Cookie", "token_v2="+tokenV2)
	req.Header.Set("User-Agent", AppConfig.Browser.UserAgent)
	if userID != "" {
		req.Header.Set("x-notion-active-user-header", userID)
	}
	req.Header.Set("x-notion-space-id", spaceID)
	req.Header.Set("notion-client-version", DefaultClientVersion)

	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[workspace] getSubscriptionData %s failed: %v", truncate(spaceID, 8), err)
		return "", ""
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		log.Printf("[workspace] getSubscriptionData %s -> %d: %s", truncate(spaceID, 8), resp.StatusCode, truncate(string(body), 160))
		return "", ""
	}

	var data map[string]json.RawMessage
	if err := json.Unmarshal(body, &data); err != nil {
		return "", ""
	}

	asString := func(key string) string {
		if raw, ok := data[key]; ok {
			var s string
			if json.Unmarshal(raw, &s) == nil {
				return s
			}
		}
		return ""
	}

	// Notion's getSubscriptionData exposes the current plan tier at the top
	// level. "type" is the canonical field; the others are defensive fallbacks.
	for _, key := range []string{"type", "subscriptionTier", "planType", "plan", "tier", "productType"} {
		if v := asString(key); isPlanKeyword(v) {
			planType = strings.ToLower(strings.TrimSpace(v))
			break
		}
	}

	// Optional marketed plan name (e.g. "Enterprise", "Business").
	for _, key := range []string{"productName", "planName", "name", "displayName"} {
		if v := strings.TrimSpace(asString(key)); v != "" {
			planName = v
			break
		}
	}

	log.Printf("[workspace] %s subscription tier=%q name=%q", truncate(spaceID, 8), planType, planName)
	return planType, planName
}

// HandleDiscoverWorkspaces discovers all workspaces for a token_v2
func HandleDiscoverWorkspaces(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if r.Method != "POST" {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}

		if auth.HasAdminPassword() && !auth.ValidateSession(r) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}

		var body struct {
			TokenV2 string `json:"token_v2"`
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

		log.Printf("[workspace] discovering workspaces from token_v2...")
		result, err := DiscoverWorkspacesFromToken(tokenV2)
		if err != nil {
			log.Printf("[workspace] discovery failed: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}

		log.Printf("[workspace] found %d workspace(s) for %s", len(result.Spaces), result.UserEmail)
		json.NewEncoder(w).Encode(result)
	}
}
