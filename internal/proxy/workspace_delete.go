package proxy

// Workspace deletion, behind the dashboard's per-space trash button.
//
// Notion's web client deletes a workspace with a single async task. Captured
// in app.notion.com_Archive [26-08-12 22-25-50].har, entry 85:
//
//	POST /api/v3/enqueueTask
//	{"task":{"eventName":"deleteSpace",
//	         "request":{"spaceId":"<space>","source":"user_initiated_deletion"},
//	         "cellRouting":{"spaceIds":[]}}}
//	-> {"taskId":"<uuid>:prod-main-usw2-0001"}
//
// A 200 here only means "queued". The client then polls:
//
//	POST /api/v3/getTasks  {"taskIds":["<taskId>"]}
//	-> {"results":[{"id":"...","state":"in_progress"|"success",...}]}
//
// In the capture the first poll (1.4s after enqueue) still reported
// in_progress and the second (3.7s) reported success, so this file polls as
// well rather than reporting a merely queued task as done.
//
// Worth noting what is NOT in the capture: no confirmation endpoint, no
// password re-entry, no separate space_view cleanup. Typing the workspace
// name into Notion's dialog is validated purely client-side, and the single
// task takes care of unlinking the space from user_root.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

const (
	// deleteSpaceSource is the literal "source" Notion's own delete dialog
	// sends. It lands in the space's audit trail, so keep it identical.
	deleteSpaceSource = "user_initiated_deletion"

	// maxDeletesPerRequest caps one request. Deletion is irreversible, so an
	// oversized list is far more dangerous here than in the create path.
	maxDeletesPerRequest = 25

	// deleteSpaceDelay paces consecutive deletions, mirroring the pacing used
	// when creating spaces in bulk.
	deleteSpaceDelay = 500 * time.Millisecond

	// deleteTaskPollAttempts and deleteTaskPollDelay bound the getTasks poll.
	// Two polls sufficed in the capture; six keeps a slow space from being
	// reported as unfinished while capping one deletion at about 7 seconds.
	deleteTaskPollAttempts = 6
	deleteTaskPollDelay    = 1200 * time.Millisecond
)

// DeletedWorkspace is one deletion outcome. State mirrors Notion's own task
// state, so a queued-but-unconfirmed deletion is reported honestly instead of
// being flattened into a plain success.
type DeletedWorkspace struct {
	SpaceID string `json:"space_id"`
	TaskID  string `json:"task_id,omitempty"`
	State   string `json:"state,omitempty"`
}

// DeleteWorkspacesResponse is the /admin/workspaces/delete payload. Like the
// create endpoint, it reports partial success instead of failing wholesale.
type DeleteWorkspacesResponse struct {
	UserID    string             `json:"user_id"`
	Requested int                `json:"requested"`
	Deleted   []DeletedWorkspace `json:"deleted"`
	Errors    []string           `json:"errors,omitempty"`
	Error     string             `json:"error,omitempty"`
}

// wsEnqueueDeleteSpace queues the deleteSpace task and returns its task id.
func wsEnqueueDeleteSpace(tokenV2, userID, spaceID string) (string, error) {
	client := getChromeHTTPClient(AppConfig.APITimeoutDuration())

	reqBody, err := json.Marshal(map[string]interface{}{
		"task": map[string]interface{}{
			"eventName": "deleteSpace",
			"request": map[string]interface{}{
				"spaceId": spaceID,
				"source":  deleteSpaceSource,
			},
			// Empty in the capture too: routing comes from the space id in the
			// request body, not from cellRouting.
			"cellRouting": map[string]interface{}{"spaceIds": []string{}},
		},
	})
	if err != nil {
		return "", fmt.Errorf("encode enqueueTask body: %w", err)
	}

	req, err := http.NewRequest("POST", NotionAPIBase+"/enqueueTask", bytes.NewReader(reqBody))
	if err != nil {
		return "", fmt.Errorf("create enqueueTask request: %w", err)
	}
	wsSetNotionHeaders(req, tokenV2, userID, spaceID)

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("enqueueTask failed: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("enqueueTask %d: %s", resp.StatusCode, truncate(string(body), 200))
	}

	var out struct {
		TaskID string `json:"taskId"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("parse enqueueTask: %w", err)
	}
	if strings.TrimSpace(out.TaskID) == "" {
		return "", fmt.Errorf("enqueueTask returned no taskId")
	}
	return out.TaskID, nil
}

// wsTaskState reads one task's state through getTasks. An unlisted task is
// reported as an empty state rather than an error: Notion drops finished
// tasks from the list, so "gone" means "done".
func wsTaskState(tokenV2, userID, spaceID, taskID string) (string, error) {
	client := getChromeHTTPClient(AppConfig.APITimeoutDuration())

	reqBody, err := json.Marshal(map[string]interface{}{"taskIds": []string{taskID}})
	if err != nil {
		return "", fmt.Errorf("encode getTasks body: %w", err)
	}
	req, err := http.NewRequest("POST", NotionAPIBase+"/getTasks", bytes.NewReader(reqBody))
	if err != nil {
		return "", fmt.Errorf("create getTasks request: %w", err)
	}
	wsSetNotionHeaders(req, tokenV2, userID, spaceID)

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("getTasks failed: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("getTasks %d: %s", resp.StatusCode, truncate(string(body), 200))
	}

	var out struct {
		Results []struct {
			ID    string `json:"id"`
			State string `json:"state"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("parse getTasks: %w", err)
	}
	for _, item := range out.Results {
		if item.ID == taskID {
			return item.State, nil
		}
	}
	return "", nil
}

// wsAwaitDeleteTask polls until the task stops reporting in_progress. Polling
// failures are deliberately non-fatal: the deletion is already queued on
// Notion's side, so the worst outcome is an honest "in_progress" answer.
func wsAwaitDeleteTask(tokenV2, userID, spaceID, taskID string) string {
	state := "in_progress"
	for i := 0; i < deleteTaskPollAttempts; i++ {
		time.Sleep(deleteTaskPollDelay)
		got, err := wsTaskState(tokenV2, userID, spaceID, taskID)
		if err != nil {
			log.Printf("[workspace] delete %s poll failed: %v", truncate(spaceID, 8), err)
			continue
		}
		if got == "" {
			return "success"
		}
		state = got
		if got != "in_progress" {
			return got
		}
	}
	return state
}

// HandleDeleteWorkspaces deletes one or more workspaces for one account token.
// Deletions run sequentially for the same reason creations do: they all write
// through that account's single user_root record.
func HandleDeleteWorkspaces(auth *DashboardAuth) http.HandlerFunc {
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
			TokenV2  string   `json:"token_v2"`
			UserID   string   `json:"user_id"`
			SpaceID  string   `json:"space_id"`
			SpaceIDs []string `json:"space_ids"`
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

		// Accept a single space_id and a space_ids list, de-duplicated so a
		// double submit cannot fire the same irreversible deletion twice.
		seen := map[string]bool{}
		ids := []string{}
		for _, raw := range append([]string{body.SpaceID}, body.SpaceIDs...) {
			id := strings.TrimSpace(raw)
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			ids = append(ids, id)
		}
		if len(ids) == 0 {
			http.Error(w, `{"error":"space_id is required"}`, http.StatusBadRequest)
			return
		}
		if len(ids) > maxDeletesPerRequest {
			ids = ids[:maxDeletesPerRequest]
		}

		userID := strings.TrimSpace(body.UserID)
		if userID == "" {
			resolved, err := wsFetchUserID(tokenV2)
			if err != nil {
				log.Printf("[workspace] delete: cannot resolve user: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
				return
			}
			userID = resolved
		}

		out := DeleteWorkspacesResponse{
			UserID:    userID,
			Requested: len(ids),
			Deleted:   []DeletedWorkspace{},
		}
		for i, spaceID := range ids {
			if i > 0 {
				time.Sleep(deleteSpaceDelay)
			}
			taskID, err := wsEnqueueDeleteSpace(tokenV2, userID, spaceID)
			if err != nil {
				log.Printf("[workspace] delete %s failed: %v", truncate(spaceID, 8), err)
				out.Errors = append(out.Errors, err.Error())
				continue
			}
			state := wsAwaitDeleteTask(tokenV2, userID, spaceID, taskID)
			log.Printf("[workspace] deleted space=%s task=%s state=%s", truncate(spaceID, 8), truncate(taskID, 8), state)
			out.Deleted = append(out.Deleted, DeletedWorkspace{
				SpaceID: spaceID,
				TaskID:  taskID,
				State:   state,
			})
			if state == "failure" {
				out.Errors = append(out.Errors, fmt.Sprintf("space %s: Notion reported the delete task as failed", truncate(spaceID, 8)))
			}
		}

		if len(out.Deleted) == 0 && len(out.Errors) > 0 {
			out.Error = out.Errors[0]
			w.WriteHeader(http.StatusBadGateway)
		}
		if err := json.NewEncoder(w).Encode(out); err != nil {
			log.Printf("[workspace] encode delete response failed: %v", err)
		}
	}
}
