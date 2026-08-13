package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
)

// McpServerInfo describes a single MCP server integration attached to a Notion
// workspace. It is a flattened merge of the two records Notion keeps for every
// connected server:
//
//   - the external connection from /api/v3/listExternalConnections, which owns
//     the connection status and the server URL, and
//   - the workflow_module record behind it, which owns the human-readable name,
//     the icon and the tool list the server advertised when it was connected.
//
// The dashboard renders this as the indicator next to the workspace name.
type McpServerInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name,omitempty"`
	Icon       string `json:"icon,omitempty"`
	URL        string `json:"url,omitempty"`
	Status     string `json:"status,omitempty"`
	ToolsCount int    `json:"tools_count"`
}

// mcpConnectedStatus is the status Notion reports for a healthy integration.
// Anything else (e.g. a half-finished OAuth handshake) is still returned to the
// caller, but it does not light the indicator up as connected.
const mcpConnectedStatus = "connected"

// mcpConnectedCount reports how many of the given servers are fully connected.
func mcpConnectedCount(servers []McpServerInfo) int {
	n := 0
	for _, s := range servers {
		if strings.EqualFold(strings.TrimSpace(s.Status), mcpConnectedStatus) {
			n++
		}
	}
	return n
}

// fetchSpaceMcpServers returns the MCP server integrations attached to a space.
//
// Step 1: /api/v3/listExternalConnections with integrationType "mcpServer"
// lists the connections. Each carries external_id / data.serverUrl (the MCP
// endpoint), a status, and a parent pointer to the workflow_module that owns it.
//
// Step 2: the name, icon and tool list live on that workflow_module record, so
// we resolve the pointers through the existing syncRecordValues helper. This
// step is best-effort: if it fails we still report the connection using the
// bare URL, because knowing that a server IS connected matters more than
// knowing what it is called.
//
// Any failure returns nil instead of an error - a missing indicator must never
// break workspace discovery.
func fetchSpaceMcpServers(tokenV2, userID, spaceID string) []McpServerInfo {
	if strings.TrimSpace(spaceID) == "" {
		return nil
	}

	conns, err := listSpaceExternalConnections(tokenV2, userID, spaceID, "mcpServer")
	if err != nil {
		log.Printf("[mcp] %s listExternalConnections: %v", truncate(spaceID, 8), err)
		return nil
	}
	if len(conns) == 0 {
		return nil
	}

	servers := make([]McpServerInfo, 0, len(conns))
	moduleIDs := make([]string, 0, len(conns))
	for _, c := range conns {
		url := strings.TrimSpace(c.Data.ServerURL)
		if url == "" {
			url = strings.TrimSpace(c.ExternalID)
		}
		parent := strings.TrimSpace(c.ParentID)
		id := parent
		if id == "" {
			id = strings.TrimSpace(c.ID)
		}
		servers = append(servers, McpServerInfo{
			ID:     id,
			URL:    url,
			Status: strings.TrimSpace(c.Status),
		})
		if parent != "" && strings.EqualFold(strings.TrimSpace(c.ParentTable), "workflow_module") {
			moduleIDs = append(moduleIDs, parent)
		}
	}

	if len(moduleIDs) > 0 {
		mods := fetchWorkflowModules(tokenV2, userID, spaceID, moduleIDs)
		for i := range servers {
			m, ok := mods[servers[i].ID]
			if !ok {
				continue
			}
			if m.Name != "" {
				servers[i].Name = m.Name
			}
			if m.Icon != "" {
				servers[i].Icon = m.Icon
			}
			if servers[i].URL == "" {
				servers[i].URL = m.ServerURL
			}
			servers[i].ToolsCount = m.ToolsCount
		}
	}

	labels := make([]string, 0, len(servers))
	for _, s := range servers {
		name := s.Name
		if name == "" {
			name = s.URL
		}
		labels = append(labels, fmt.Sprintf("%s [%s]", name, s.Status))
	}
	log.Printf("[mcp] %s -> %d server(s): %s", truncate(spaceID, 8), len(servers), strings.Join(labels, ", "))

	return servers
}

// externalConnection mirrors the subset of a /api/v3/listExternalConnections
// entry that the dashboard needs.
type externalConnection struct {
	ID          string `json:"id"`
	ParentID    string `json:"parent_id"`
	ParentTable string `json:"parent_table"`
	ExternalID  string `json:"external_id"`
	Status      string `json:"status"`
	Type        string `json:"integration_type"`
	Data        struct {
		ServerURL string `json:"serverUrl"`
	} `json:"data"`
}

// listSpaceExternalConnections calls /api/v3/listExternalConnections for a
// single space and integration type.
func listSpaceExternalConnections(tokenV2, userID, spaceID, integrationType string) ([]externalConnection, error) {
	client := getChromeHTTPClient(AppConfig.APITimeoutDuration())
	reqBody, _ := json.Marshal(map[string]string{
		"spaceId":         spaceID,
		"integrationType": integrationType,
	})
	req, err := http.NewRequest("POST", NotionAPIBase+"/listExternalConnections", bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
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
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode, truncate(string(body), 160))
	}

	var payload struct {
		Connections []externalConnection `json:"connections"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	return payload.Connections, nil
}

// workflowModuleInfo is the flattened workflow_module record.
type workflowModuleInfo struct {
	Name       string
	Icon       string
	ServerURL  string
	ToolsCount int
}

// workflowModuleRecord is the raw shape stored in the workflow_module table.
type workflowModuleRecord struct {
	ID         string `json:"id"`
	Alive      bool   `json:"alive"`
	ModuleType string `json:"module_type"`
	Data       struct {
		Name      string            `json:"name"`
		Icon      string            `json:"icon"`
		ServerURL string            `json:"serverUrl"`
		Tools     []json.RawMessage `json:"tools"`
	} `json:"data"`
}

// fetchWorkflowModules resolves workflow_module records by id through the
// existing syncRecordValues helper and returns them keyed by record id.
func fetchWorkflowModules(tokenV2, userID, spaceID string, ids []string) map[string]workflowModuleInfo {
	if len(ids) == 0 {
		return nil
	}
	pointers := make([]map[string]string, 0, len(ids))
	for _, id := range ids {
		pointers = append(pointers, map[string]string{
			"table":   "workflow_module",
			"id":      id,
			"spaceId": spaceID,
		})
	}

	raw, err := syncRecordValues(tokenV2, userID, spaceID, pointers)
	if err != nil {
		log.Printf("[mcp] %s workflow_module sync: %v", truncate(spaceID, 8), err)
		return nil
	}

	var payload struct {
		RecordMap struct {
			WorkflowModule map[string]json.RawMessage `json:"workflow_module"`
		} `json:"recordMap"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil
	}

	out := make(map[string]workflowModuleInfo, len(payload.RecordMap.WorkflowModule))
	for id, rec := range payload.RecordMap.WorkflowModule {
		var outer struct {
			Value json.RawMessage `json:"value"`
		}
		if json.Unmarshal(rec, &outer) != nil || len(outer.Value) == 0 {
			continue
		}
		// Notion nests the payload as value.value; older shapes put the record
		// directly under value, so unwrap only when the inner key exists.
		inner := outer.Value
		var nested struct {
			Value json.RawMessage `json:"value"`
		}
		if json.Unmarshal(outer.Value, &nested) == nil && len(nested.Value) > 0 {
			inner = nested.Value
		}

		var mod workflowModuleRecord
		if err := json.Unmarshal(inner, &mod); err != nil {
			continue
		}
		if !mod.Alive {
			continue
		}
		out[id] = workflowModuleInfo{
			Name:       strings.TrimSpace(mod.Data.Name),
			Icon:       strings.TrimSpace(mod.Data.Icon),
			ServerURL:  strings.TrimSpace(mod.Data.ServerURL),
			ToolsCount: len(mod.Data.Tools),
		}
	}
	return out
}
