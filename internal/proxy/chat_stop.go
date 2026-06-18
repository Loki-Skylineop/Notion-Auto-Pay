package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// HandleChatStop aborts the in-flight inference for a thread exactly the way the
// Notion web client does when you press the Stop button: it clears the thread's
// current_inference_id / lease via saveTransactionsFanout
// ("AgentChatTranscript.StopInference.stopButtonClick"). Once the inference id
// is cleared Notion tears down the running turn, so the held
// runInferenceTranscript stream on /admin/chat/stream ends shortly after.
func HandleChatStop(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !chatAuthOK(auth, w, r) {
			return
		}
		var body struct {
			TokenV2  string `json:"token_v2"`
			UserID   string `json:"user_id"`
			SpaceID  string `json:"space_id"`
			ThreadID string `json:"thread_id"`
		}
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
		op := map[string]interface{}{
			"pointer": map[string]string{"table": "thread", "id": body.ThreadID, "spaceId": body.SpaceID},
			"path":    []string{},
			"command": "update",
			"args": map[string]interface{}{
				"current_inference_id":               nil,
				"current_inference_lease_expiration": nil,
			},
		}
		tx := map[string]interface{}{
			"id":         generateUUIDv4(),
			"spaceId":    body.SpaceID,
			"debug":      map[string]string{"userAction": "AgentChatTranscript.StopInference.stopButtonClick"},
			"operations": []interface{}{op},
		}
		reqBody, _ := json.Marshal(map[string]interface{}{
			"requestId":    generateUUIDv4(),
			"transactions": []interface{}{tx},
		})
		resp, err := notionChatRequest(body.TokenV2, body.UserID, body.SpaceID, "saveTransactionsFanout", reqBody, "application/json", chatAPITimeout())
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		defer resp.Body.Close()
		io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("notion %d", resp.StatusCode)})
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})
	}
}
