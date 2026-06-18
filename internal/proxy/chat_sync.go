package proxy

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// chat_sync.go adds a lightweight, version-gated poll of a single thread's live
// state. The real Notion web client continuously polls
// syncRecordValuesSpaceInitial (~1x/second) so an open chat keeps reflecting
// new messages, turn start/stop and even turns started on another device, and
// so it self-heals when the runInferenceTranscript stream drops. Our single
// long-lived /admin/chat/stream connection cannot do that on its own, which is
// why the user had to reopen a thread to see the final state of the last
// message. HandleChatSync mirrors the web client's polling: it reads the
// thread record and reports whether a turn is still in-flight
// (current_inference_id set + lease in the future) and, when the thread has
// advanced past the caller's since_version, the freshly rebuilt history.

// parseLeaseMs extracts the epoch-ms value from current_inference_lease_expiration.
// Notion encodes it as a JSON string (e.g. "1781735475702") but it may also be a
// bare number or null; returns 0 when absent or unparseable.
func parseLeaseMs(raw json.RawMessage) int64 {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return 0
	}
	s = strings.Trim(s, "\"")
	if s == "" {
		return 0
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	return n
}

// HandleChatSync reports a thread's live state for the dashboard's poll loop.
func HandleChatSync(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !chatAuthOK(auth, w, r) {
			return
		}
		var body struct {
			TokenV2      string `json:"token_v2"`
			UserID       string `json:"user_id"`
			SpaceID      string `json:"space_id"`
			ThreadID     string `json:"thread_id"`
			SinceVersion int    `json:"since_version"`
		}
		body.SinceVersion = -1
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		body.TokenV2 = strings.TrimSpace(body.TokenV2)
		body.SpaceID = strings.TrimSpace(body.SpaceID)
		body.ThreadID = strings.TrimSpace(body.ThreadID)
		if body.TokenV2 == "" || body.SpaceID == "" || body.ThreadID == "" {
			http.Error(w, `{"error":"token_v2, space_id and thread_id are required"}`, http.StatusBadRequest)
			return
		}

		threadData, err := syncRecordValues(body.TokenV2, body.UserID, body.SpaceID, []map[string]string{
			{"table": "thread", "id": body.ThreadID, "spaceId": body.SpaceID},
		})
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		var tr struct {
			RecordMap struct {
				Thread map[string]struct {
					Value struct {
						Value struct {
							Version                         int             `json:"version"`
							Messages                        []string        `json:"messages"`
							CurrentInferenceID              string          `json:"current_inference_id"`
							CurrentInferenceLeaseExpiration json.RawMessage `json:"current_inference_lease_expiration"`
							LastTurnOutcome                 struct {
								Status string `json:"status"`
							} `json:"last_turn_outcome"`
						} `json:"value"`
					} `json:"value"`
				} `json:"thread"`
			} `json:"recordMap"`
		}
		json.Unmarshal(threadData, &tr)

		var order []string
		version := -1
		running := false
		outcome := ""
		if t, ok := tr.RecordMap.Thread[body.ThreadID]; ok {
			tv := t.Value.Value
			order = tv.Messages
			version = tv.Version
			outcome = tv.LastTurnOutcome.Status
			leaseMs := parseLeaseMs(tv.CurrentInferenceLeaseExpiration)
			running = strings.TrimSpace(tv.CurrentInferenceID) != "" && leaseMs > time.Now().UnixMilli()
		}

		// Version gate: when the caller already holds this thread version, skip the
		// heavier message refetch and just report liveness — this mirrors the web
		// client's version-pinned syncRecordValuesSpaceInitial polling.
		if body.SinceVersion >= 0 && version >= 0 && body.SinceVersion == version {
			json.NewEncoder(w).Encode(map[string]interface{}{
				"running": running,
				"version": version,
				"outcome": outcome,
				"changed": false,
			})
			return
		}

		messages := []chatHistMsg{}
		if len(order) > 0 {
			pointers := make([]map[string]string, 0, len(order))
			for _, id := range order {
				pointers = append(pointers, map[string]string{"table": "thread_message", "id": id, "spaceId": body.SpaceID})
			}
			msgData, err := syncRecordValues(body.TokenV2, body.UserID, body.SpaceID, pointers)
			if err != nil {
				w.WriteHeader(http.StatusBadGateway)
				json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
				return
			}
			var wrap struct {
				RecordMap recordMapShape `json:"recordMap"`
			}
			json.Unmarshal(msgData, &wrap)
			messages = buildHistory(wrap.RecordMap, order)
		}

		json.NewEncoder(w).Encode(map[string]interface{}{
			"running":  running,
			"version":  version,
			"outcome":  outcome,
			"changed":  true,
			"messages": messages,
		})
	}
}
