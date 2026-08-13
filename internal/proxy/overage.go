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
	"sync"
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

// ---- keeping the switch closed ----
//
// Turning "use additional credits" on is one write; turning it back off has to
// be treated as a promise. A single lost write - Notion answering 5xx, the
// token being briefly rate limited, the turn ending while the workspace is
// busy - used to leave the switch open until somebody noticed by hand, which
// is exactly how a workspace quietly keeps spending extra credits. So every
// disable is now written, read back and retried: a couple of times inside the
// request, then in the background for as long as it takes.

const (
	// Attempts made while the turn's HTTP handler is still alive. Deliberately
	// few, so the answer is not delayed; the chaser below does the rest.
	overageDisableTries = 2
	overageDisableDelay = 600 * time.Millisecond
	// Background attempts once the synchronous ones failed. The delay grows
	// linearly up to overageMaxDelay, covering roughly ten minutes of outage.
	overageChaseTries = 30
	overageChaseDelay = 5 * time.Second
	overageMaxDelay   = 30 * time.Second
	// A turn that never released its hold (panic, killed stream, leaked defer)
	// stops protecting the switch after this long.
	overageStaleTurn = 15 * time.Minute
	// How often the watchdog looks for workspaces that are still open.
	overageSweepEvery = time.Minute
)

// overageArm is the bookkeeping for one workspace whose switch this process
// forced on. turns counts the chat turns currently relying on it, so parallel
// chats in the same workspace cannot close the switch under each other.
type overageArm struct {
	tokenV2 string
	userID  string
	turns   int
	armedAt time.Time
	chasing bool
}

var (
	overageMu       sync.Mutex
	overageArmed    = map[string]*overageArm{}
	overageWatchdog sync.Once
)

// overageAcquire registers one in-flight turn and reports whether it is the
// first one, i.e. whether the caller still has to flip the switch on.
func overageAcquire(tokenV2, userID, spaceID string) bool {
	overageMu.Lock()
	defer overageMu.Unlock()
	arm := overageArmed[spaceID]
	if arm == nil {
		arm = &overageArm{}
		overageArmed[spaceID] = arm
	}
	arm.tokenV2 = tokenV2
	arm.userID = userID
	arm.turns++
	arm.armedAt = time.Now()
	return arm.turns == 1
}

// overageRelease drops one in-flight turn and returns how many are left. A
// workspace this process does not know about reports zero, so a stray release
// still closes the switch instead of silently skipping it.
func overageRelease(spaceID string) int {
	overageMu.Lock()
	defer overageMu.Unlock()
	arm := overageArmed[spaceID]
	if arm == nil {
		return 0
	}
	if arm.turns > 0 {
		arm.turns--
	}
	return arm.turns
}

// overageIdle reports whether no turn is holding the switch open right now.
func overageIdle(spaceID string) bool {
	overageMu.Lock()
	defer overageMu.Unlock()
	arm := overageArmed[spaceID]
	return arm == nil || arm.turns == 0
}

// overageForget drops the bookkeeping once the switch is confirmed closed,
// unless a new turn armed it again in the meantime.
func overageForget(spaceID string) {
	overageMu.Lock()
	defer overageMu.Unlock()
	if arm := overageArmed[spaceID]; arm != nil && arm.turns == 0 {
		delete(overageArmed, spaceID)
	}
}

// disableOverageOnce writes "disabled" and reads the setting back, so both a
// failed write and a write that silently did not stick count as a failure.
func disableOverageOnce(tokenV2, userID, spaceID string) bool {
	if err := setSpaceOveragePolicy(tokenV2, userID, spaceID, overagePolicyOff); err != nil {
		log.Printf("[overage] %s disable failed: %v", truncate(spaceID, 8), err)
		return false
	}
	policy := fetchSpaceOveragePolicy(tokenV2, userID, spaceID)
	if policy == "" {
		// Read-back unavailable. The write itself reported success, and the
		// watchdog is still there if Notion disagrees.
		return true
	}
	if overageEnabled(policy) {
		log.Printf("[overage] %s still reads %q right after disable", truncate(spaceID, 8), policy)
		return false
	}
	return true
}

// disableOverageInsist retries disableOverageOnce with a growing, capped delay.
// It stops early when a new turn arms the workspace again - that turn owns the
// switch now and will close it when it is done.
func disableOverageInsist(tokenV2, userID, spaceID string, tries int, delay time.Duration) bool {
	for i := 1; i <= tries; i++ {
		if !overageIdle(spaceID) {
			log.Printf("[overage] %s a new turn took over - leaving the switch to it", truncate(spaceID, 8))
			return true
		}
		if disableOverageOnce(tokenV2, userID, spaceID) {
			log.Printf("[overage] %s additional credits OFF again (attempt %d/%d)", truncate(spaceID, 8), i, tries)
			return true
		}
		if i == tries {
			break
		}
		wait := delay * time.Duration(i)
		if wait > overageMaxDelay {
			wait = overageMaxDelay
		}
		time.Sleep(wait)
	}
	return false
}

// overageChase keeps trying in the background after the synchronous attempts
// gave up, so a lost write cannot leave the workspace open. One chaser per
// workspace; the watchdog starts another one if this one runs out of tries.
func overageChase(tokenV2, userID, spaceID string) {
	overageMu.Lock()
	arm := overageArmed[spaceID]
	if arm == nil {
		arm = &overageArm{tokenV2: tokenV2, userID: userID, armedAt: time.Now()}
		overageArmed[spaceID] = arm
	}
	if arm.chasing || arm.turns > 0 {
		overageMu.Unlock()
		return
	}
	arm.chasing = true
	overageMu.Unlock()

	go func() {
		defer func() {
			overageMu.Lock()
			if a := overageArmed[spaceID]; a != nil {
				a.chasing = false
			}
			overageMu.Unlock()
		}()
		if disableOverageInsist(tokenV2, userID, spaceID, overageChaseTries, overageChaseDelay) {
			overageForget(spaceID)
			return
		}
		log.Printf("[overage] %s STILL ON after %d background tries - the watchdog will keep going", truncate(spaceID, 8), overageChaseTries)
	}()
}

// startOverageWatchdog closes switches nobody managed to close: a chaser that
// ran out of tries, or a turn that hung on to its hold for far too long.
func startOverageWatchdog() {
	go func() {
		type pending struct{ tokenV2, userID, spaceID string }
		for {
			time.Sleep(overageSweepEvery)
			var jobs []pending
			overageMu.Lock()
			for spaceID, arm := range overageArmed {
				if arm.chasing {
					continue
				}
				if arm.turns > 0 {
					if time.Since(arm.armedAt) < overageStaleTurn {
						continue
					}
					log.Printf("[overage] %s a turn has held the switch for %s - forcing it closed", truncate(spaceID, 8), time.Since(arm.armedAt).Round(time.Second))
					arm.turns = 0
				}
				jobs = append(jobs, pending{arm.tokenV2, arm.userID, spaceID})
			}
			overageMu.Unlock()
			for _, j := range jobs {
				overageChase(j.tokenV2, j.userID, j.spaceID)
			}
		}
	}()
}

// armOverageForTurn is the auto-pilot around a single chat turn. Once the
// sliding window is fully drained Notion refuses the turn unless additional
// credits are allowed, so the switch is flipped on immediately before the
// request and closed again the moment the turn finishes.
//
// The current state of the switch is deliberately never consulted. Whatever it
// was - off, on, or unreadable - a drained window means force it on now and
// force it off afterwards. That makes every send behave identically and
// guarantees the workspace is never left open, at the cost of also closing a
// switch that somebody had turned on by hand.
//
// The returned closure is the "off" half: it releases this turn's hold and,
// when it was the last one, insists on the switch being closed - writing,
// verifying and retrying, in the background if necessary. It is a no-op only
// when the window was not drained in the first place, so deferring it is always
// safe, and calling it more than once is safe too.
func armOverageForTurn(tokenV2, userID, spaceID string) func() {
	noop := func() {}
	if strings.TrimSpace(tokenV2) == "" || strings.TrimSpace(spaceID) == "" {
		return noop
	}
	rl := fetchSpaceCreditRateLimit(tokenV2, userID, spaceID)
	if !rollingWindowMaxed(rl) {
		return noop
	}
	overageWatchdog.Do(startOverageWatchdog)
	// Forced on unconditionally, without reading the policy first. A failed
	// write is logged but must not skip the off half below, so the turn always
	// ends with the switch closed no matter which state it started in.
	if overageAcquire(tokenV2, userID, spaceID) {
		if err := setSpaceOveragePolicy(tokenV2, userID, spaceID, overagePolicyOn); err != nil {
			log.Printf("[overage] %s enable failed: %v", truncate(spaceID, 8), err)
		} else {
			log.Printf("[overage] %s sliding window drained -> additional credits ON for this turn", truncate(spaceID, 8))
		}
	} else {
		log.Printf("[overage] %s another turn is already running -> additional credits stay ON", truncate(spaceID, 8))
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			if left := overageRelease(spaceID); left > 0 {
				log.Printf("[overage] %s turn finished, %d still running -> switch stays ON", truncate(spaceID, 8), left)
				return
			}
			if disableOverageInsist(tokenV2, userID, spaceID, overageDisableTries, overageDisableDelay) {
				overageForget(spaceID)
				return
			}
			log.Printf("[overage] %s could not close the switch in %d tries -> retrying in the background", truncate(spaceID, 8), overageDisableTries)
			overageChase(tokenV2, userID, spaceID)
		})
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
