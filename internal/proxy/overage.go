package proxy

// overage.go drives Notion's "use additional credits" switch.
//
// Captured from a HAR of the real toggle: the web client flips it with a single
// saveTransactionsFanout transaction tagged AiSettings.toggleCreditOverage - an
// "update" on space.settings carrying one key:
//
//	ai_credit_overage_policy: "disabled"              <- off
//	ai_credit_overage_policy: "all_workspace_members" <- on
//
// Because the command is "update" (a merge), only that one key has to be sent.
// The browser resends the whole settings blob, but that is just how its local
// record cache works, not a requirement of the endpoint.

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

const (
	overagePolicyOn  = "all_workspace_members"
	overagePolicyOff = "disabled"
)

// overageEnabled reports whether a raw ai_credit_overage_policy value means the
// switch is on. Notion writes "disabled" when it is off, so any other non-empty
// value counts as enabled.
func overageEnabled(policy string) bool {
	p := strings.TrimSpace(policy)
	if p == "" {
		return false
	}
	return !strings.EqualFold(p, overagePolicyOff)
}

// rollingWindowMaxed reports whether the short sliding window is completely
// drained. Notion scales both numbers to 100 and reports two decimals, so the
// comparison keeps a small tolerance instead of demanding an exact match.
func rollingWindowMaxed(rl spaceRateLimit) bool {
	if !rl.OK || rl.RollingLimit <= 0 {
		return false
	}
	return rl.RollingUsed >= rl.RollingLimit-0.005
}

// fetchSpaceOveragePolicy reads space.settings.ai_credit_overage_policy for one
// workspace. An empty string means "unknown", which the UI treats as off.
func fetchSpaceOveragePolicy(tokenV2, userID, spaceID string) string {
	data, err := syncRecordValues(tokenV2, userID, spaceID, []map[string]string{
		{"table": "space", "id": spaceID, "spaceId": spaceID},
	})
	if err != nil {
		log.Printf("[overage] read %s failed: %v", truncate(spaceID, 8), err)
		return ""
	}
	return overagePolicyFromRecord(data, spaceID)
}

// overagePolicyFromRecord digs the policy out of a syncRecordValues payload.
// The record arrives as recordMap.space.<id>.value and is sometimes wrapped in
// a second "value" object, so both shapes are handled.
func overagePolicyFromRecord(data []byte, spaceID string) string {
	type settingsShape struct {
		Policy string `json:"ai_credit_overage_policy"`
	}
	var rm struct {
		RecordMap struct {
			Space map[string]struct {
				Value struct {
					Value *struct {
						Settings settingsShape `json:"settings"`
					} `json:"value"`
					Settings settingsShape `json:"settings"`
				} `json:"value"`
			} `json:"space"`
		} `json:"recordMap"`
	}
	if err := json.Unmarshal(data, &rm); err != nil {
		return ""
	}
	rec, ok := rm.RecordMap.Space[spaceID]
	if !ok {
		for _, v := range rm.RecordMap.Space {
			rec = v
			break
		}
	}
	if rec.Value.Value != nil {
		return rec.Value.Value.Settings.Policy
	}
	return rec.Value.Settings.Policy
}

// setSpaceOveragePolicy flips the switch by replaying the captured transaction.
func setSpaceOveragePolicy(tokenV2, userID, spaceID, policy string) error {
	tx := map[string]interface{}{
		"requestId": wsNewUUID(),
		"transactions": []map[string]interface{}{{
			"id":      wsNewUUID(),
			"spaceId": spaceID,
			"debug": map[string]interface{}{
				"userAction":         "AiSettings.toggleCreditOverage",
				"clientCommitTimeMs": time.Now().UnixMilli(),
			},
			"operations": []map[string]interface{}{{
				"pointer": map[string]string{"table": "space", "id": spaceID, "spaceId": spaceID},
				"path":    []string{"settings"},
				"command": "update",
				"args":    map[string]interface{}{"ai_credit_overage_policy": policy},
			}},
		}},
	}
	body, _ := json.Marshal(tx)
	resp, err := notionChatRequest(tokenV2, userID, spaceID, "saveTransactionsFanout", body, "application/json", chatAPITimeout())
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("saveTransactionsFanout %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}
	return nil
}

// armOverageForTurn is the auto-pilot around a single chat turn. Once the
// sliding window is fully drained Notion refuses the turn unless additional
// credits are allowed, so the switch is flipped on immediately before the
// request and back off the moment the turn finishes.
//
// The current state of the switch is deliberately never consulted. Whatever it
// was - off, on, or unreadable - a drained window means force it on now and
// force it off afterwards. That makes every send behave identically and
// guarantees the workspace is never left open, at the cost of also closing a
// switch that somebody had turned on by hand.
//
// The returned closure is the "off" half. It is a no-op only when the window
// was not drained in the first place, so deferring it is always safe.
func armOverageForTurn(tokenV2, userID, spaceID string) func() {
	noop := func() {}
	if strings.TrimSpace(tokenV2) == "" || strings.TrimSpace(spaceID) == "" {
		return noop
	}
	rl := fetchSpaceCreditRateLimit(tokenV2, userID, spaceID)
	if !rollingWindowMaxed(rl) {
		return noop
	}
	// Forced on unconditionally, without reading the policy first. A failed
	// write is logged but must not skip the off half below, so the turn always
	// ends with the switch closed no matter which state it started in.
	if err := setSpaceOveragePolicy(tokenV2, userID, spaceID, overagePolicyOn); err != nil {
		log.Printf("[overage] %s enable failed: %v", truncate(spaceID, 8), err)
	} else {
		log.Printf("[overage] %s sliding window drained -> additional credits ON for this turn", truncate(spaceID, 8))
	}
	return func() {
		if err := setSpaceOveragePolicy(tokenV2, userID, spaceID, overagePolicyOff); err != nil {
			log.Printf("[overage] %s disable failed: %v", truncate(spaceID, 8), err)
			return
		}
		log.Printf("[overage] %s additional credits OFF again", truncate(spaceID, 8))
	}
}

// overageToggleRequest is the dashboard's manual override.
type overageToggleRequest struct {
	TokenV2 string `json:"token_v2"`
	UserID  string `json:"user_id"`
	SpaceID string `json:"space_id"`
	Enabled bool   `json:"enabled"`
}

// HandleOverageToggle turns "use additional credits" on or off for one
// workspace, so the indicator in the pool doubles as a switch.
func HandleOverageToggle(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !chatAuthOK(auth, w, r) {
			return
		}
		var req overageToggleRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		req.TokenV2 = strings.TrimSpace(req.TokenV2)
		req.UserID = strings.TrimSpace(req.UserID)
		req.SpaceID = strings.TrimSpace(req.SpaceID)
		if req.TokenV2 == "" || req.SpaceID == "" {
			http.Error(w, `{"error":"token_v2 and space_id are required"}`, http.StatusBadRequest)
			return
		}
		policy := overagePolicyOff
		if req.Enabled {
			policy = overagePolicyOn
		}
		if err := setSpaceOveragePolicy(req.TokenV2, req.UserID, req.SpaceID, policy); err != nil {
			log.Printf("[overage] %s manual toggle failed: %v", truncate(req.SpaceID, 8), err)
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]interface{}{"error": err.Error()})
			return
		}
		log.Printf("[overage] %s manual toggle -> %s", truncate(req.SpaceID, 8), policy)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":      true,
			"policy":  policy,
			"enabled": req.Enabled,
		})
	}
}
