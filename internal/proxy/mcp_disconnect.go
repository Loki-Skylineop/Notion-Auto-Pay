package proxy

// mcp_disconnect.go detaches an MCP server from a single workspace.
//
// It replays the one transaction the Notion web client sends when a user
// presses "Disconnect" on a personal MCP server. Captured from a HAR of that
// flow, debug.userAction "ConnectionSurfaceTabs.disconnectPersonalMcpServer":
//
//	saveTransactionsFanout, ONE transaction carrying TWO operations
//	  1. space_view      path ["settings"] update
//	     args.agent_chat_modules = current list minus this module
//	  2. workflow_module path []           update
//	     args.alive = false
//
// There is no dedicated delete endpoint and no external_connection write: the
// module flipping to alive:false is what makes listExternalConnections answer
// {"connections":[]} on the very next call. Both operations must travel inside
// the same transaction, otherwise a failure in between leaves the space_view
// pointing at a dead module, or a live module orphaned out of the chat picker.

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// McpDisconnectResult is the dashboard-facing result of one disconnect attempt.
type McpDisconnectResult struct {
	OK       bool   `json:"ok"`
	ModuleID string `json:"module_id,omitempty"`
	Error    string `json:"error,omitempty"`
}

// mcpDisconnectRequest is the dashboard -> server payload. Either module_id or
// server_url identifies the target. Both paths exist because the badge in the
// workspace pool always knows the URL, while the module id is only present once
// discovery has resolved the external connection behind it.
type mcpDisconnectRequest struct {
	TokenV2     string `json:"token_v2"`
	UserID      string `json:"user_id"`
	SpaceID     string `json:"space_id"`
	SpaceViewID string `json:"space_view_id"`
	ModuleID    string `json:"module_id"`
	ServerURL   string `json:"server_url"`
}

func mcpWriteDisconnect(w http.ResponseWriter, status int, res McpDisconnectResult) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(res)
}

// HandleMcpDisconnect serves POST /admin/mcp/disconnect.
func HandleMcpDisconnect(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !chatAuthOK(auth, w, r) {
			return
		}

		var body mcpDisconnectRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			mcpWriteDisconnect(w, http.StatusBadRequest, McpDisconnectResult{Error: "invalid request body"})
			return
		}
		body.TokenV2 = strings.TrimSpace(body.TokenV2)
		body.UserID = strings.TrimSpace(body.UserID)
		body.SpaceID = strings.TrimSpace(body.SpaceID)
		body.SpaceViewID = strings.TrimSpace(body.SpaceViewID)
		body.ModuleID = strings.TrimSpace(body.ModuleID)
		body.ServerURL = strings.TrimSpace(body.ServerURL)

		if body.TokenV2 == "" || body.SpaceID == "" {
			mcpWriteDisconnect(w, http.StatusBadRequest, McpDisconnectResult{Error: "token_v2 and space_id are required"})
			return
		}
		if body.UserID == "" {
			mcpWriteDisconnect(w, http.StatusBadRequest, McpDisconnectResult{Error: "user_id is required (re-run workspace discovery)"})
			return
		}
		if body.ModuleID == "" && body.ServerURL == "" {
			mcpWriteDisconnect(w, http.StatusBadRequest, McpDisconnectResult{Error: "module_id or server_url is required"})
			return
		}

		shortID := truncate(body.SpaceID, 8)

		// The badge sends whatever it has. When only the URL is known, resolve it
		// the same way the indicator does: the external connection carries
		// parent_id -> workflow_module, and that module id is the disconnect
		// target (NOT the external_connection id).
		moduleID := body.ModuleID
		if moduleID == "" {
			moduleID = mcpResolveModuleByURL(body.TokenV2, body.UserID, body.SpaceID, body.ServerURL)
		}
		if moduleID == "" {
			mcpWriteDisconnect(w, http.StatusNotFound, McpDisconnectResult{Error: "MCP-\u0441\u0435\u0440\u0432\u0435\u0440 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d \u0432 \u044d\u0442\u043e\u043c \u043f\u0440\u043e\u0441\u0442\u0440\u0430\u043d\u0441\u0442\u0432\u0435"})
			return
		}

		// The chat client reads its MCP list from space_view.settings, so a
		// disconnect that does not know the space_view id cannot finish the job.
		spaceViewID := body.SpaceViewID
		if spaceViewID == "" {
			resolved, err := mcpResolveSpaceViewID(body.TokenV2, body.UserID, body.SpaceID)
			if err != nil {
				log.Printf("[mcp-disconnect] %s space_view lookup failed: %v", shortID, err)
				mcpWriteDisconnect(w, http.StatusBadGateway, McpDisconnectResult{ModuleID: moduleID, Error: "\u043d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043e\u043f\u0440\u0435\u0434\u0435\u043b\u0438\u0442\u044c space_view \u0434\u043b\u044f \u044d\u0442\u043e\u0433\u043e \u043f\u0440\u043e\u0441\u0442\u0440\u0430\u043d\u0441\u0442\u0432\u0430"})
				return
			}
			spaceViewID = resolved
		}

		if err := mcpDetachModule(body.TokenV2, body.UserID, body.SpaceID, spaceViewID, moduleID); err != nil {
			log.Printf("[mcp-disconnect] %s failed: %v", shortID, err)
			mcpWriteDisconnect(w, http.StatusBadGateway, McpDisconnectResult{ModuleID: moduleID, Error: mcpFriendlyError(err)})
			return
		}

		log.Printf("[mcp-disconnect] %s detached workflow_module %s", shortID, truncate(moduleID, 8))
		mcpWriteDisconnect(w, http.StatusOK, McpDisconnectResult{OK: true, ModuleID: moduleID})
	}
}

// mcpResolveModuleByURL finds the workflow_module standing behind a server URL.
// Trailing slashes and letter case differ between what the dashboard shows and
// what Notion stored, so both are normalised before comparing.
func mcpResolveModuleByURL(tokenV2, userID, spaceID, serverURL string) string {
	conns, err := listSpaceExternalConnections(tokenV2, userID, spaceID, "mcpServer")
	if err != nil {
		log.Printf("[mcp-disconnect] %s listExternalConnections: %v", truncate(spaceID, 8), err)
		return ""
	}
	want := strings.TrimRight(strings.ToLower(strings.TrimSpace(serverURL)), "/")
	if want == "" {
		return ""
	}
	for _, c := range conns {
		if !strings.EqualFold(strings.TrimSpace(c.ParentTable), "workflow_module") {
			continue
		}
		for _, candidate := range []string{c.Data.ServerURL, c.ExternalID} {
			got := strings.TrimRight(strings.ToLower(strings.TrimSpace(candidate)), "/")
			if got != "" && got == want {
				return strings.TrimSpace(c.ParentID)
			}
		}
	}
	return ""
}

// mcpDetachModule sends the two-operation disconnect transaction.
func mcpDetachModule(tokenV2, userID, spaceID, spaceViewID, moduleID string) error {
	// Read the current pointer list and drop just this one. A blind overwrite
	// with an empty array would unlink every other server attached to the space.
	existing := mcpExistingModules(tokenV2, userID, spaceID, spaceViewID)
	kept := make([]agentChatModulePointer, 0, len(existing))
	found := false
	for _, m := range existing {
		if strings.EqualFold(strings.TrimSpace(m.Pointer.ID), moduleID) {
			found = true
			continue
		}
		kept = append(kept, m)
	}
	if !found {
		// Not linked into the picker (half-finished connect, already removed on
		// another device), or the pointer list could not be read at all:
		// mcpExistingModules swallows its error and answers nil. Rewriting the
		// list from here would be a no-op in the first case and would unlink
		// every OTHER MCP server of this space in the second, so the space_view
		// is left alone and only the module itself is killed.
		log.Printf("[mcp-disconnect] %s module %s not in agent_chat_modules, skipping space_view rewrite", truncate(spaceID, 8), truncate(moduleID, 8))
	}

	unlink := map[string]interface{}{
		"pointer": map[string]string{
			"table":   "space_view",
			"id":      spaceViewID,
			"spaceId": spaceID,
		},
		"path":    []string{"settings"},
		"command": "update",
		"args": map[string]interface{}{
			"agent_chat_modules": kept,
		},
	}
	kill := map[string]interface{}{
		"pointer": map[string]string{
			"table":   "workflow_module",
			"id":      moduleID,
			"spaceId": spaceID,
		},
		"path":    []string{},
		"command": "update",
		"args": map[string]interface{}{
			"alive": false,
		},
	}

	// One transaction, exactly like the web client - minus the space_view
	// operation when there is nothing safe to rewrite there.
	ops := make([]map[string]interface{}, 0, 2)
	if found {
		ops = append(ops, unlink)
	}
	ops = append(ops, kill)

	return mcpSaveTransactionOps(
		tokenV2, userID, spaceID,
		"ConnectionSurfaceTabs.disconnectPersonalMcpServer",
		ops,
	)
}

// mcpSaveTransactionOps posts several saveTransactionsFanout operations inside
// a single transaction. mcpSaveTransaction (mcp_connect.go) is the one-operation
// shortcut over the same body; disconnect needs two, and they must be atomic.
func mcpSaveTransactionOps(tokenV2, userID, spaceID, userAction string, ops []map[string]interface{}) error {
	if len(ops) == 0 {
		return nil
	}
	reqBody, err := json.Marshal(map[string]interface{}{
		"requestId": wsNewUUID(),
		"transactions": []map[string]interface{}{
			{
				"id":      wsNewUUID(),
				"spaceId": spaceID,
				"debug": map[string]interface{}{
					"userAction":         userAction,
					"clientCommitTimeMs": time.Now().UnixMilli(),
				},
				"operations": ops,
			},
		},
	})
	if err != nil {
		return fmt.Errorf("encode %s body: %w", userAction, err)
	}

	resp, err := notionChatRequest(tokenV2, userID, spaceID, "saveTransactionsFanout", reqBody, "application/json", chatAPITimeout())
	if err != nil {
		return fmt.Errorf("%s failed: %w", userAction, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("%s %d: %s", userAction, resp.StatusCode, truncate(string(data), 240))
	}
	return nil
}
