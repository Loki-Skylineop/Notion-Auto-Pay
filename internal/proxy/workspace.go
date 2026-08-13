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
	// AICreditsUsed / AICreditsLimit describe the workspace's premium AI credit
	// budget for the current service period (e.g. 0 used out of 400). They are
	// pulled from /api/v3/getAIUsageEligibilityV2 and drive the per-workspace
	// progress bar in the UI. AICreditsLimit == 0 means the space has no premium
	// AI budget, so the UI hides the bar.
	AICreditsUsed  int `json:"ai_credits_used"`
	AICreditsLimit int `json:"ai_credits_limit"`
	// BasicCreditsUsed / BasicCreditsLimit describe the SEPARATE basic credit
	// allowance that the ordinary, non-premium agent spends (e.g. 1708 used out
	// of 75). It comes from the basicCredits block of the same
	// getAIUsageEligibilityV2 payload. On paid plans basic AI is not metered, so
	// usage happily runs past the nominal limit; BasicCreditsUnlimited records
	// that so the UI can draw a full bar plus the raw counters instead of a
	// nonsense percentage.
	BasicCreditsUsed      int  `json:"basic_credits_used"`
	BasicCreditsLimit     int  `json:"basic_credits_limit"`
	BasicCreditsUnlimited bool `json:"basic_credits_unlimited"`
	// The next block mirrors the two gauges Notion draws on its own "Limits"
	// tab, both from /api/v3/getCreditRateLimitStatus. Rolling* is the short
	// SLIDING window (RollingWindow is its size, e.g. "6h") that throttles
	// bursts and frees up again after RollingResetsInSec seconds. Period* is
	// the allowance for the whole billing period, resetting at PeriodEndMs.
	// Notion already reports both as a used/limit pair scaled to 100, so the
	// percentages are its numbers, not ours. RateLimitOK is false when the
	// call failed, which tells the UI to hide both bars instead of showing a
	// misleading 0%.
	RateLimitOK        bool    `json:"rate_limit_ok"`
	RollingUsed        float64 `json:"rolling_used"`
	RollingLimit       float64 `json:"rolling_limit"`
	RollingWindow      string  `json:"rolling_window"`
	RollingResetsInSec int64   `json:"rolling_resets_in_sec"`
	PeriodUsed         float64 `json:"period_used"`
	PeriodLimit        float64 `json:"period_limit"`
	PeriodEndMs        int64   `json:"period_end_ms"`
	// McpConnected reports whether this workspace has at least one MCP server
	// integration in the "connected" state, per /api/v3/listExternalConnections
	// with integrationType "mcpServer". McpServers carries the resolved details
	// (name, icon, URL, tool count) so the dashboard can label the indicator it
	// draws next to the workspace name.
	McpConnected bool            `json:"mcp_connected"`
	McpServers   []McpServerInfo `json:"mcp_servers,omitempty"`
	// OveragePolicy mirrors space.settings.ai_credit_overage_policy, the "use
	// additional credits" switch on Notion's AI settings page ("disabled" = off,
	// "all_workspace_members" = on). OverageEnabled is the ready-made boolean the
	// dashboard indicator reads; it only matters once a workspace has drained its
	// sliding window, which is the only time the UI shows it.
	OveragePolicy  string `json:"overage_policy,omitempty"`
	OverageEnabled bool   `json:"overage_enabled"`
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

	// Enrich each space with its REAL subscription tier + AI credit balance
	// (concurrently).
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

			// Per-workspace credit budgets for the progress bars: the premium
			// pool first, then the basic allowance the ordinary agent spends.
			u := fetchSpaceAIUsage(tokenV2, userID, spaces[idx].SpaceID)
			spaces[idx].AICreditsUsed = u.PremiumUsed
			spaces[idx].AICreditsLimit = u.PremiumLimit
			spaces[idx].BasicCreditsUsed = u.BasicUsed
			spaces[idx].BasicCreditsLimit = u.BasicLimit
			spaces[idx].BasicCreditsUnlimited = u.BasicUnlimited

			// ...plus the two throttling windows the Limits tab shows.
			rl := fetchSpaceCreditRateLimit(tokenV2, userID, spaces[idx].SpaceID)
			spaces[idx].RateLimitOK = rl.OK
			spaces[idx].RollingUsed = rl.RollingUsed
			spaces[idx].RollingLimit = rl.RollingLimit
			spaces[idx].RollingWindow = rl.RollingWindow
			spaces[idx].RollingResetsInSec = rl.RollingResets
			spaces[idx].PeriodUsed = rl.PeriodUsed
			spaces[idx].PeriodLimit = rl.PeriodLimit
			spaces[idx].PeriodEndMs = rl.PeriodEndMs

			// ...and finally the MCP server integrations that drive the
			// connection indicator next to the workspace name.
			servers := fetchSpaceMcpServers(tokenV2, userID, spaces[idx].SpaceID)
			spaces[idx].McpServers = servers
			spaces[idx].McpConnected = mcpConnectedCount(servers) > 0

			// ...and the "use additional credits" switch, so the pool can show
			// whether overage is armed on a workspace that hit its limit.
			pol := fetchSpaceOveragePolicy(tokenV2, userID, spaces[idx].SpaceID)
			spaces[idx].OveragePolicy = pol
			spaces[idx].OverageEnabled = overageEnabled(pol)
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

// fetchSpaceAIUsage queries /api/v3/getAIUsageEligibilityV2 for a single space
// and returns both credit budgets the dashboard draws: the premium AI credit
// pool for the current service period (e.g. 0 used out of 400) and the separate
// basic allowance that the ordinary, non-premium agent spends (e.g. 1708 used
// out of 75). A zero limit means the space has no such budget, so the UI hides
// that particular bar. Returns the zero value on any failure.
func fetchSpaceAIUsage(tokenV2, userID, spaceID string) (usage spaceAIUsage) {
	if spaceID == "" {
		return usage
	}
	client := getChromeHTTPClient(AppConfig.APITimeoutDuration())
	reqBody, _ := json.Marshal(map[string]string{"spaceId": spaceID})
	req, err := http.NewRequest("POST", NotionAPIBase+"/getAIUsageEligibilityV2", bytes.NewReader(reqBody))
	if err != nil {
		return usage
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
		log.Printf("[workspace] getAIUsageEligibilityV2 %s failed: %v", truncate(spaceID, 8), err)
		return usage
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		log.Printf("[workspace] getAIUsageEligibilityV2 %s -> %d: %s", truncate(spaceID, 8), resp.StatusCode, truncate(string(body), 160))
		return usage
	}

	// The payload carries two independent budgets:
	//   * top-level usage/limits    -> PREMIUM AI credits (the "400")
	//   * basicCredits/limits.free  -> the basic allowance the ORDINARY agent
	//     spends (the "75"). We surface both, the UI draws a bar for each.
	var data struct {
		Usage struct {
			CurrentServicePeriod struct {
				SpaceUsage float64 `json:"spaceUsage"`
			} `json:"currentServicePeriod"`
			Lifetime struct {
				SpaceUsage float64 `json:"spaceUsage"`
			} `json:"lifetime"`
			TotalCreditBalance float64 `json:"totalCreditBalance"`
		} `json:"usage"`
		Limits struct {
			Purchased struct {
				TotalLimit float64 `json:"totalLimit"`
				PerSource  struct {
					MonthlyAllocated float64 `json:"monthlyAllocated"`
				} `json:"perSource"`
			} `json:"purchased"`
			Free struct {
				SpaceLimit float64 `json:"spaceLimit"`
			} `json:"free"`
		} `json:"limits"`
		BasicCredits struct {
			SpaceUsage float64 `json:"spaceUsage"`
			SpaceLimit float64 `json:"spaceLimit"`
		} `json:"basicCredits"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return usage
	}

	// ---- premium credits ------------------------------------------------
	limit := int(data.Limits.Purchased.TotalLimit)
	if limit == 0 {
		limit = int(data.Limits.Purchased.PerSource.MonthlyAllocated)
	}
	used := int(data.Usage.CurrentServicePeriod.SpaceUsage)
	// Fallback: if the period counter was empty but a remaining balance is
	// reported below the limit, derive used from (limit - balance).
	if used == 0 && limit > 0 {
		bal := int(data.Usage.TotalCreditBalance)
		if bal > 0 && bal < limit {
			used = limit - bal
		}
	}
	if used < 0 {
		used = 0
	}
	if limit > 0 && used > limit {
		used = limit
	}
	usage.PremiumUsed = used
	usage.PremiumLimit = limit

	// ---- basic credits (the ordinary agent) -------------------------------
	basicUsed := int(data.BasicCredits.SpaceUsage)
	if basicUsed == 0 {
		basicUsed = int(data.Usage.Lifetime.SpaceUsage)
	}
	basicLimit := int(data.BasicCredits.SpaceLimit)
	if basicLimit == 0 {
		basicLimit = int(data.Limits.Free.SpaceLimit)
	}
	if basicUsed < 0 {
		basicUsed = 0
	}
	// Deliberately NOT clamped: paid spaces keep counting basic usage far past
	// the free allowance (Notion reports type "unlimited" there), and the raw
	// number is the interesting part. Flag it instead.
	usage.BasicUsed = basicUsed
	usage.BasicLimit = basicLimit
	usage.BasicUnlimited = basicLimit > 0 && basicUsed > basicLimit

	log.Printf("[workspace] %s ai credits used=%d limit=%d | basic used=%d limit=%d unlimited=%v",
		truncate(spaceID, 8), usage.PremiumUsed, usage.PremiumLimit,
		usage.BasicUsed, usage.BasicLimit, usage.BasicUnlimited)
	return usage
}

// fetchSpaceCreditRateLimit queries /api/v3/getCreditRateLimitStatus, the
// endpoint behind the two gauges on Notion's own "Limits" tab. "window" is the
// short SLIDING window (labelled "Rolling", currently 6h) that throttles bursts
// and frees up again after resetsInSeconds, while "billingPeriodWindow" is the
// allowance for the whole billing period (labelled "Monthly") that resets at
// periodEndMs. Both arrive as a used/limit pair already scaled to 100, so the
// percentages the dashboard shows are Notion's own numbers rather than
// something we derive. OK stays false on any failure so the UI can hide both
// bars instead of drawing two empty ones.
func fetchSpaceCreditRateLimit(tokenV2, userID, spaceID string) (rl spaceRateLimit) {
	if spaceID == "" {
		return rl
	}
	client := getChromeHTTPClient(AppConfig.APITimeoutDuration())
	reqBody, _ := json.Marshal(map[string]string{"spaceId": spaceID})
	req, err := http.NewRequest("POST", NotionAPIBase+"/getCreditRateLimitStatus", bytes.NewReader(reqBody))
	if err != nil {
		return rl
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
		log.Printf("[workspace] getCreditRateLimitStatus %s failed: %v", truncate(spaceID, 8), err)
		return rl
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		log.Printf("[workspace] getCreditRateLimitStatus %s -> %d: %s", truncate(spaceID, 8), resp.StatusCode, truncate(string(body), 160))
		return rl
	}

	var data struct {
		Window struct {
			Window string  `json:"window"`
			Used   float64 `json:"used"`
			Limit  float64 `json:"limit"`
		} `json:"window"`
		BillingPeriodWindow struct {
			Used        float64 `json:"used"`
			Limit       float64 `json:"limit"`
			PeriodEndMs float64 `json:"periodEndMs"`
		} `json:"billingPeriodWindow"`
		ResetsInSeconds float64 `json:"resetsInSeconds"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return rl
	}

	rl.RollingUsed = data.Window.Used
	rl.RollingLimit = data.Window.Limit
	rl.RollingWindow = data.Window.Window
	rl.RollingResets = int64(data.ResetsInSeconds)
	rl.PeriodUsed = data.BillingPeriodWindow.Used
	rl.PeriodLimit = data.BillingPeriodWindow.Limit
	rl.PeriodEndMs = int64(data.BillingPeriodWindow.PeriodEndMs)
	// Only claim success once at least one window came back with a real cap;
	// an empty 200 would otherwise render two permanently empty bars.
	rl.OK = rl.RollingLimit > 0 || rl.PeriodLimit > 0

	log.Printf("[workspace] %s rate limit rolling=%.2f/%.2f (%s, resets in %ds) period=%.2f/%.2f",
		truncate(spaceID, 8), rl.RollingUsed, rl.RollingLimit, rl.RollingWindow, rl.RollingResets,
		rl.PeriodUsed, rl.PeriodLimit)
	return rl
}

// spaceAIUsage bundles the two credit budgets that
// /api/v3/getAIUsageEligibilityV2 reports for a single workspace.
type spaceAIUsage struct {
	PremiumUsed    int
	PremiumLimit   int
	BasicUsed      int
	BasicLimit     int
	BasicUnlimited bool
}

// spaceRateLimit bundles the two throttling windows that
// /api/v3/getCreditRateLimitStatus reports for a single workspace.
type spaceRateLimit struct {
	OK            bool
	RollingUsed   float64
	RollingLimit  float64
	RollingWindow string
	RollingResets int64
	PeriodUsed    float64
	PeriodLimit   float64
	PeriodEndMs   int64
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
