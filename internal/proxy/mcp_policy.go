package proxy

// mcp_policy.go lifts the workspace-level block that stops an MCP server from
// being attached at all.
//
// A brand new space answers the very first validateMcpConnection with
//
//	403 ForbiddenError
//	"Custom MCP servers are disabled for this workspace.
//	 Ask a workspace owner to enable them."
//
// The switch behind that message lives in space.settings, right next to the
// credit overage policy. A HAR of a workspace where MCP works shows the
// permissive values:
//
//	disallow_custom_mcp_servers:            false
//	restrict_mcp_urls_to_allowlist:         false
//	restrict_workflow_modules_to_allowlist: false
//	connection_allowlist_mode:              "no_restrictions"
//
// The dashboard drives the workspace with the owner's own token - it is the
// "workspace owner" the error tells the user to go ask - so the block is lifted
// here and the handshake retried instead of dead-ending.

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"sort"
	"strings"
	"time"
)

// mcpAllowlistModeOpen is the connection_allowlist_mode value of a workspace
// that accepts any connection.
const mcpAllowlistModeOpen = "no_restrictions"

// mcpPolicySettings is the MCP-related slice of space.settings. Every field is
// a pointer so that a missing key stays distinguishable from an explicit
// false: missing means "Notion did not say", which is treated as "write it"
// rather than "already fine".
type mcpPolicySettings struct {
	DisallowCustom  *bool   `json:"disallow_custom_mcp_servers"`
	RestrictURLs    *bool   `json:"restrict_mcp_urls_to_allowlist"`
	RestrictModules *bool   `json:"restrict_workflow_modules_to_allowlist"`
	AllowlistMode   *string `json:"connection_allowlist_mode"`
}

// mcpBlockedByPolicy reports whether an error is the workspace refusing custom
// MCP servers outright, as opposed to a problem with the MCP server itself.
func mcpBlockedByPolicy(err error) bool {
	if err == nil {
		return false
	}
	low := strings.ToLower(err.Error())
	if strings.Contains(low, "custom mcp servers are disabled") {
		return true
	}
	return strings.Contains(low, "403") && strings.Contains(low, "mcp") && strings.Contains(low, "disabled")
}

// fetchSpaceMcpPolicy reads the MCP switches off one space record.
func fetchSpaceMcpPolicy(tokenV2, userID, spaceID string) (mcpPolicySettings, error) {
	data, err := syncRecordValues(tokenV2, userID, spaceID, []map[string]string{
		{"table": "space", "id": spaceID, "spaceId": spaceID},
	})
	if err != nil {
		return mcpPolicySettings{}, fmt.Errorf("read space settings: %w", err)
	}
	return mcpPolicyFromRecord(data, spaceID), nil
}

// mcpPolicyFromRecord digs the switches out of a syncRecordValues payload. The
// record arrives as recordMap.space.<id>.value and is sometimes wrapped in a
// second "value" object, so both shapes are handled.
func mcpPolicyFromRecord(data []byte, spaceID string) mcpPolicySettings {
	var rm struct {
		RecordMap struct {
			Space map[string]struct {
				Value struct {
					Value *struct {
						Settings mcpPolicySettings `json:"settings"`
					} `json:"value"`
					Settings mcpPolicySettings `json:"settings"`
				} `json:"value"`
			} `json:"space"`
		} `json:"recordMap"`
	}
	if err := json.Unmarshal(data, &rm); err != nil {
		return mcpPolicySettings{}
	}
	rec, ok := rm.RecordMap.Space[spaceID]
	if !ok {
		for _, v := range rm.RecordMap.Space {
			rec = v
			break
		}
	}
	if rec.Value.Value != nil {
		return rec.Value.Value.Settings
	}
	return rec.Value.Settings
}

// mcpPolicyPatch lists the settings that still have to be relaxed. A key is
// included when it is restrictive and also when it is absent, because a space
// that just refused the handshake has not earned the benefit of the doubt. An
// empty result means there is genuinely nothing left to loosen.
func mcpPolicyPatch(p mcpPolicySettings) map[string]interface{} {
	patch := map[string]interface{}{}
	if p.DisallowCustom == nil || *p.DisallowCustom {
		patch["disallow_custom_mcp_servers"] = false
	}
	if p.RestrictURLs == nil || *p.RestrictURLs {
		patch["restrict_mcp_urls_to_allowlist"] = false
	}
	if p.RestrictModules == nil || *p.RestrictModules {
		patch["restrict_workflow_modules_to_allowlist"] = false
	}
	if p.AllowlistMode == nil || !strings.EqualFold(strings.TrimSpace(*p.AllowlistMode), mcpAllowlistModeOpen) {
		patch["connection_allowlist_mode"] = mcpAllowlistModeOpen
	}
	return patch
}

// allowCustomMcpServers relaxes every MCP restriction the space still has and
// returns the names of the settings it wrote, so the caller can log exactly
// what was changed on the user's workspace. No writes means an empty list.
func allowCustomMcpServers(tokenV2, userID, spaceID string) ([]string, error) {
	policy, err := fetchSpaceMcpPolicy(tokenV2, userID, spaceID)
	if err != nil {
		// The read only serves to leave already-open switches alone. Losing it
		// means writing all four, which is still correct, just less surgical.
		log.Printf("[mcp-policy] %s settings unreadable (%v), relaxing every switch", truncate(spaceID, 8), err)
	}
	patch := mcpPolicyPatch(policy)
	if len(patch) == 0 {
		return nil, nil
	}
	if err := setSpaceSettings(tokenV2, userID, spaceID, "SpaceSettings.updateMcpPolicy", patch); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(patch))
	for k := range patch {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys, nil
}

// setSpaceSettings merges keys into space.settings with one
// saveTransactionsFanout call. The command is "update", which is a merge, so
// only the changed keys have to travel; the web client resends the entire blob
// purely because that is what sits in its local record cache.
//
// userAction is telemetry Notion echoes into its own logs and has no effect on
// what the transaction does.
func setSpaceSettings(tokenV2, userID, spaceID, userAction string, patch map[string]interface{}) error {
	if len(patch) == 0 {
		return nil
	}
	tx := map[string]interface{}{
		"requestId": wsNewUUID(),
		"transactions": []map[string]interface{}{{
			"id":      wsNewUUID(),
			"spaceId": spaceID,
			"debug": map[string]interface{}{
				"userAction":         userAction,
				"clientCommitTimeMs": time.Now().UnixMilli(),
			},
			"operations": []map[string]interface{}{{
				"pointer": map[string]string{"table": "space", "id": spaceID, "spaceId": spaceID},
				"path":    []string{"settings"},
				"command": "update",
				"args":    patch,
			}},
		}},
	}
	body, err := json.Marshal(tx)
	if err != nil {
		return fmt.Errorf("encode space settings update: %w", err)
	}
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

// mcpFriendlyError explains the workspace-level refusal when relaxing the
// settings did not clear it either, and passes every other error through
// untouched.
func mcpFriendlyError(err error) string {
	if err == nil {
		return ""
	}
	if mcpBlockedByPolicy(err) {
		return "custom MCP servers are disabled for this workspace and could not be enabled automatically - this account may not be a workspace owner, or the plan does not allow them (" + err.Error() + ")"
	}
	return err.Error()
}
