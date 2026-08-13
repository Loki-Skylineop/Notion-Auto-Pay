package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// chat_queue.go teaches the chat to accept a message while the agent is still
// working, exactly like the real Notion web client does.
//
// Before this file existed the dashboard parked anything typed during a running
// turn in a browser-local queue and only sent it once the turn had finished, so
// the agent could not see the new message until it went idle. The capture from
// app.notion.com shows what the web client really does: it POSTs the message to
// queueAgentChatMessage immediately, Notion appends it to the *running* thread
// as a user step marked "queued": true, and the same runInferenceTranscript
// response keeps going with a second agent-inference that answers it (steps
// /s/8 and /s/9 of that capture, 42 ms apart, with no second inference request
// at all and the whole context preserved).
//
// HandleChatQueue replays that call. The answer arrives through the stream that
// is already open — see the "user" event emitted by processStreamLine.

// chatQueueBody is the /admin/chat/queue request. It carries the same identity
// fields as a normal send, but thread_id is mandatory: a message can only be
// appended to a thread that already exists.
type chatQueueBody struct {
	TokenV2     string           `json:"token_v2"`
	UserID      string           `json:"user_id"`
	UserName    string           `json:"user_name"`
	UserEmail   string           `json:"user_email"`
	SpaceID     string           `json:"space_id"`
	SpaceViewID string           `json:"space_view_id"`
	SpaceName   string           `json:"space_name"`
	Timezone    string           `json:"timezone"`
	Agent       string           `json:"agent"`
	ThreadID    string           `json:"thread_id"`
	Message     string           `json:"message"`
	Attachments []chatAttachment `json:"attachments"`
}

// buildQueuePayload renders the queueAgentChatMessage body. The steps mirror the
// tail of buildSendPayload: the context element (so the injected message keeps
// this chat's surface, timezone and workspace), the updated-config element that
// keeps MCP servers enabled, any attachments, and the user text itself.
func buildQueuePayload(body chatQueueBody) (map[string]interface{}, string) {
	isCustom := body.Agent != "" && body.Agent != "default"
	tz := strings.TrimSpace(body.Timezone)
	if tz == "" {
		tz = "UTC"
	}
	ctxVal := map[string]interface{}{
		"timezone":        tz,
		"userName":        body.UserName,
		"userId":          body.UserID,
		"userEmail":       body.UserEmail,
		"spaceName":       body.SpaceName,
		"spaceId":         body.SpaceID,
		"spaceViewId":     body.SpaceViewID,
		"currentDatetime": time.Now().Format("2006-01-02T15:04:05.000-07:00"),
	}
	if isCustom {
		ctxVal["surface"] = "custom_agent"
		ctxVal["workflowId"] = body.Agent
	} else {
		ctxVal["surface"] = "ai_module"
	}
	stepID := generateUUIDv4()
	steps := []interface{}{
		map[string]interface{}{
			"id":    generateUUIDv4(),
			"type":  "context",
			"value": ctxVal,
		},
		map[string]interface{}{
			"id":   generateUUIDv4(),
			"type": "updated-config",
			"value": map[string]interface{}{
				"enableScriptAgentMcpServers": true,
			},
		},
	}
	steps = append(steps, attachmentSteps(body.Attachments)...)
	steps = append(steps, map[string]interface{}{
		"id":        stepID,
		"type":      "user",
		"value":     [][]string{{body.Message}},
		"userId":    body.UserID,
		"createdAt": time.Now().UnixMilli(),
	})
	return map[string]interface{}{
		"threadId": strings.TrimSpace(body.ThreadID),
		"spaceId":  body.SpaceID,
		"steps":    steps,
	}, stepID
}

// HandleChatQueue appends a message to a thread whose turn is still running so
// the agent picks it up without waiting for the current answer to finish.
func HandleChatQueue(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !chatAuthOK(auth, w, r) {
			return
		}
		var body chatQueueBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		body.TokenV2 = strings.TrimSpace(body.TokenV2)
		body.SpaceID = strings.TrimSpace(body.SpaceID)
		body.ThreadID = strings.TrimSpace(body.ThreadID)
		body.Message = strings.TrimSpace(body.Message)
		if body.TokenV2 == "" || body.SpaceID == "" || body.ThreadID == "" || body.Message == "" {
			http.Error(w, `{"error":"token_v2, space_id, thread_id and message are required"}`, http.StatusBadRequest)
			return
		}
		payload, stepID := buildQueuePayload(body)
		reqBody, _ := json.Marshal(payload)
		resp, err := notionChatRequest(body.TokenV2, body.UserID, body.SpaceID, "queueAgentChatMessage", reqBody, "application/json", chatAPITimeout())
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]interface{}{"queued": false, "error": err.Error()})
			return
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			// Notion refuses the call when the turn has already ended; the
			// dashboard then falls back to sending the text as a new turn.
			log.Printf("[chat] queue %d: %s", resp.StatusCode, truncate(string(raw), 300))
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"queued": false,
				"error":  fmt.Sprintf("notion error %d", resp.StatusCode),
			})
			return
		}
		var parsed struct {
			MessageIDs []string `json:"messageIds"`
		}
		json.Unmarshal(raw, &parsed)
		ids := parsed.MessageIDs
		if len(ids) == 0 {
			ids = []string{stepID}
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"queued":      true,
			"step_id":     stepID,
			"message_ids": ids,
		})
	}
}