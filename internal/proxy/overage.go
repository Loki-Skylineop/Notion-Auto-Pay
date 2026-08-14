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
// is exactly how a workspace quietly keeps spending extra credits.
//
// Worse, a single read-back is not proof either: saveTransactionsFanout is
// applied asynchronously, so syncRecordValues can still answer with the old
// value right after a successful write, and a value that reads "disabled"
// immediately has still been seen to come back on a moment later. Trusting that
// one read is exactly why the switch "sometimes" stayed on.
//
// So a disable is never a single request any more. Each disable is
//
//  1. written,
//  2. read back several times before it is believed,
//  3. re-checked once more overageConfirmDelay later, when Notion has certainly
//     applied the transaction,
//  4. written again from scratch whenever any of those checks disagrees,
//
// and the whole cycle repeats in the background until Notion confirms "off",
// with the watchdog as the last line of defence.

const (
	// Attempts made while the turn's HTTP handler is still alive. Deliberately
	// few, so the answer is not delayed; the closer below does the rest.
	overageDisableTries = 3
	overageDisableDelay = 400 * time.Millisecond

	// How many times the policy is read back before a disable is believed. One
	// read is a coin flip against an eventually consistent record cache, so the
	// verification asks again with a short gap in between.
	overageVerifyReads = 3
	overageVerifyGap   = 700 * time.Millisecond

	// The heart of "check it again in five seconds": how long to wait after a
	// disable before asking Notion once more, and how many write + re-check
	// rounds one closer runs before it leaves the rest to the watchdog.
	overageConfirmDelay = 5 * time.Second
	overageEnsureRounds = 6

	// Attempts inside a background round once the quick ones failed. The delay
	// grows linearly up to overageMaxDelay.
	overageChaseTries = 10
	overageChaseDelay = 5 * time.Second
	overageMaxDelay   = 30 * time.Second

	// A turn that never released its hold (panic, killed stream, leaked defer)
	// stops protecting the switch after this long.
	overageStaleTurn = 15 * time.Minute

	// How often the watchdog looks for workspaces that are still open.
	overageSweepEvery = 20 * time.Second
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

// overageReadOff asks Notion for the current policy up to reads times and
// reports (off, known). known is false when every read came back empty, i.e.
// the state could not be established at all - in that case off means nothing
// and the caller must keep trying rather than declare success. A single read
// that says "on" is enough to fail the check.
func overageReadOff(tokenV2, userID, spaceID string, reads int, gap time.Duration) (bool, bool) {
	if reads < 1 {
		reads = 1
	}
	known := false
	for i := 1; i <= reads; i++ {
		policy := fetchSpaceOveragePolicy(tokenV2, userID, spaceID)
		if strings.TrimSpace(policy) != "" {
			known = true
			if overageEnabled(policy) {
				log.Printf("[overage] %s read %d/%d still reports %q", truncate(spaceID, 8), i, reads, policy)
				return false, true
			}
		}
		if i < reads {
			time.Sleep(gap)
		}
	}
	if !known {
		return false, false
	}
	return true, true
}

// disableOverageOnce writes "disabled" and reads the setting back, so both a
// failed write and a write that silently did not stick count as a failure.
// reads controls how thorough the read-back is: one for the inline attempt that
// must not slow the answer down, overageVerifyReads for the background passes
// where being sure matters more than being quick.
func disableOverageOnce(tokenV2, userID, spaceID string, reads int) bool {
	if err := setSpaceOveragePolicy(tokenV2, userID, spaceID, overagePolicyOff); err != nil {
		log.Printf("[overage] %s disable failed: %v", truncate(spaceID, 8), err)
		return false
	}
	off, known := overageReadOff(tokenV2, userID, spaceID, reads, overageVerifyGap)
	if !known {
		// Read-back unavailable. The write itself reported success, and the
		// delayed re-check plus the watchdog are still there if Notion
		// disagrees, so this is reported as "probably fine" rather than done.
		log.Printf("[overage] %s disable written but the read-back is unavailable", truncate(spaceID, 8))
		return true
	}
	return off
}

// disableOverageLoop retries disableOverageOnce with a growing, capped delay.
// Unless force is set it stops early when a new turn arms the workspace again -
// that turn owns the switch now and will close it when it is done. force is for
// an explicit "off" from the dashboard or the chat UI, which must be obeyed even
// while a turn is still running.
func disableOverageLoop(tokenV2, userID, spaceID string, tries int, delay time.Duration, force bool) bool {
	for i := 1; i <= tries; i++ {
		if !force && !overageIdle(spaceID) {
			log.Printf("[overage] %s a new turn took over - leaving the switch to it", truncate(spaceID, 8))
			return true
		}
		if disableOverageOnce(tokenV2, userID, spaceID, overageVerifyReads) {
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

// disableOverageInsist is the cooperative form of disableOverageLoop, used by
// everything that runs on behalf of a finished turn.
func disableOverageInsist(tokenV2, userID, spaceID string, tries int, delay time.Duration) bool {
	return disableOverageLoop(tokenV2, userID, spaceID, tries, delay, false)
}

// overageEnsureOff is the background closer, and the reason a disable can be
// promised rather than hoped for. One closer per workspace runs rounds of
// "write disabled -> wait overageConfirmDelay -> ask Notion again", and only a
// confirmed "off" ends it. Anything else - still on, or unreadable - starts
// another round, because both mean the workspace may still be spending.
//
// force skips the checks that hand the switch back to a running turn, for an
// explicit "off" that must win regardless.
func overageEnsureOff(tokenV2, userID, spaceID string, force bool) {
	if strings.TrimSpace(tokenV2) == "" || strings.TrimSpace(spaceID) == "" {
		return
	}
	overageWatchdog.Do(startOverageWatchdog)
	overageMu.Lock()
	arm := overageArmed[spaceID]
	if arm == nil {
		arm = &overageArm{tokenV2: tokenV2, userID: userID, armedAt: time.Now()}
		overageArmed[spaceID] = arm
	}
	if arm.tokenV2 == "" {
		arm.tokenV2 = tokenV2
	}
	if arm.userID == "" {
		arm.userID = userID
	}
	// One closer per workspace: several of them would only multiply identical
	// writes. A turn holding the switch wins unless this is a forced off.
	if arm.chasing || (!force && arm.turns > 0) {
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
		for round := 1; round <= overageEnsureRounds; round++ {
			if !force && !overageIdle(spaceID) {
				log.Printf("[overage] %s a new turn took over - leaving the switch to it", truncate(spaceID, 8))
				return
			}
			tries, delay := overageDisableTries, overageDisableDelay
			if round > 1 {
				// The quick path already failed once, so give later rounds the
				// patience of a background job.
				tries, delay = overageChaseTries, overageChaseDelay
			}
			if !disableOverageLoop(tokenV2, userID, spaceID, tries, delay, force) {
				log.Printf("[overage] %s round %d/%d could not close the switch - re-checking anyway", truncate(spaceID, 8), round, overageEnsureRounds)
			}
			// The whole point of this pass: never trust the read that happens
			// straight after the write. Wait until Notion has certainly applied
			// the transaction, then ask again.
			time.Sleep(overageConfirmDelay)
			if !force && !overageIdle(spaceID) {
				log.Printf("[overage] %s a new turn took over during the re-check", truncate(spaceID, 8))
				return
			}
			off, known := overageReadOff(tokenV2, userID, spaceID, overageVerifyReads, overageVerifyGap)
			if known && off {
				log.Printf("[overage] %s additional credits confirmed OFF %s later (round %d/%d)", truncate(spaceID, 8), overageConfirmDelay, round, overageEnsureRounds)
				overageForget(spaceID)
				return
			}
			if known {
				log.Printf("[overage] %s STILL ON %s after the disable (round %d/%d) - writing it again", truncate(spaceID, 8), overageConfirmDelay, round, overageEnsureRounds)
			} else {
				log.Printf("[overage] %s could not read the switch back (round %d/%d) - writing it again", truncate(spaceID, 8), round, overageEnsureRounds)
			}
		}
		log.Printf("[overage] %s not confirmed OFF after %d rounds - the watchdog will keep going", truncate(spaceID, 8), overageEnsureRounds)
	}()
}

// startOverageWatchdog closes switches nobody managed to close: a closer that
// ran out of rounds, or a turn that hung on to its hold for far too long.
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
				overageEnsureOff(j.tokenV2, j.userID, j.spaceID, false)
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
// when it was the last one, closes the switch immediately and then keeps
// proving it stayed closed - one verified write inline, then the background
// closer with its five-second re-checks. It is a no-op only when the window was
// not drained in the first place, so deferring it is always safe, and calling it
// more than once is safe too.
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
			// One fast, verified attempt inline, so the switch is already closed
			// by the time the answer is delivered. A single read-back here keeps
			// the request short; being sure is the closer's job.
			if disableOverageOnce(tokenV2, userID, spaceID, 1) {
				log.Printf("[overage] %s additional credits OFF right after the turn - re-checking in %s", truncate(spaceID, 8), overageConfirmDelay)
			} else {
				log.Printf("[overage] %s the first disable did not stick - the closer takes over", truncate(spaceID, 8))
			}
			// And now the part that makes it stick: write again, wait five
			// seconds, read it back, repeat until Notion confirms "off".
			overageEnsureOff(tokenV2, userID, spaceID, false)
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
//
// "Off" is not a single write here either. It is retried and verified inline,
// the background closer is kicked so the state is re-checked once more five
// seconds later, and the answer carries "verified" so the caller knows whether
// Notion actually confirmed it or only accepted the write. Unlike the end of a
// turn, this off is forced: the chat UI fires it as soon as the agent starts
// answering, while the server-side turn is still holding the switch open.
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
		if !req.Enabled {
			verified := disableOverageLoop(req.TokenV2, req.UserID, req.SpaceID, overageDisableTries, overageDisableDelay, true)
			overageEnsureOff(req.TokenV2, req.UserID, req.SpaceID, true)
			log.Printf("[overage] %s manual disable -> verified=%v, re-checking in %s", truncate(req.SpaceID, 8), verified, overageConfirmDelay)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":       true,
				"policy":   overagePolicyOff,
				"enabled":  false,
				"verified": verified,
			})
			return
		}
		if err := setSpaceOveragePolicy(req.TokenV2, req.UserID, req.SpaceID, overagePolicyOn); err != nil {
			log.Printf("[overage] %s manual toggle failed: %v", truncate(req.SpaceID, 8), err)
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]interface{}{"error": err.Error()})
			return
		}
		log.Printf("[overage] %s manual toggle -> %s", truncate(req.SpaceID, 8), overagePolicyOn)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":       true,
			"policy":   overagePolicyOn,
			"enabled":  true,
			"verified": true,
		})
	}
}

// overageStatusRequest asks for the live value of one workspace's switch.
type overageStatusRequest struct {
	TokenV2 string `json:"token_v2"`
	UserID  string `json:"user_id"`
	SpaceID string `json:"space_id"`
	Reads   int    `json:"reads"`
}

// HandleOverageStatus reads ai_credit_overage_policy straight from Notion, so
// the UI can verify a disable instead of assuming it worked. The pool cache is
// no use for that: the server flips the switch on for the duration of a turn
// without the frontend ever hearing about it, which is why the old client-side
// "only disable when overage_enabled" check silently did nothing.
//
// known is false when the value could not be read at all - then enabled must be
// ignored. holding reports whether a turn on this server is still relying on
// the switch, which makes a lingering "on" expected rather than a bug.
func HandleOverageStatus(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !chatAuthOK(auth, w, r) {
			return
		}
		var req overageStatusRequest
		if r.Method == http.MethodGet {
			req.TokenV2 = r.URL.Query().Get("token_v2")
			req.UserID = r.URL.Query().Get("user_id")
			req.SpaceID = r.URL.Query().Get("space_id")
		} else if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
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
		reads := req.Reads
		if reads < 1 {
			reads = 1
		}
		if reads > overageVerifyReads {
			reads = overageVerifyReads
		}
		policy := ""
		for i := 1; i <= reads; i++ {
			policy = fetchSpaceOveragePolicy(req.TokenV2, req.UserID, req.SpaceID)
			// Stop on the first answer that says "on": that is the one worth
			// reporting, and re-reading could only hide it.
			if overageEnabled(policy) {
				break
			}
			if i < reads {
				time.Sleep(overageVerifyGap)
			}
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":      true,
			"policy":  policy,
			"enabled": overageEnabled(policy),
			"known":   strings.TrimSpace(policy) != "",
			"holding": !overageIdle(req.SpaceID),
		})
	}
}
