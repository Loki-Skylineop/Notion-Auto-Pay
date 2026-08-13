package proxy

// mcp_connect.go attaches an MCP server to a single workspace.
//
// It replays the exact five-call sequence the Notion web client performs when
// a user adds an MCP server by hand (captured from a HAR of that flow):
//
//  1. validateMcpConnection         - handshake, returns the server's tool list
//  2. saveTransactionsFanout        - createAgentChatModule: workflow_module record
//  3. postWorkflowsMcpServerConnect - stores the secret, marks it "connected"
//  4. saveTransactionsFanout        - addAgentChatModule: links it into space_view
//  5. saveTransactionsFanout        - updateMcpToolPermissions: auto-run switches
//
// Step 3 is what makes Notion write data.connectionPointer onto the module
// record, and the chat client skips every module without it, so the order above
// is not negotiable. Step 4 is additive: the current agent_chat_modules list is
// read first, so servers already attached to the space are preserved. Step 5
// carries only the two "run tools automatically" switches - the rest of the
// record was already filled in server-side during step 3.

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// mcpDefaultIcon is the robot emoji the web client stores for MCP modules.
const mcpDefaultIcon = "\U0001F916"

// mcpDefaultEnabled preselects a freshly attached server in new chats. The web
// client stores false here because a human is sitting in front of the chat
// picker to flip the switch; nothing flips it in a headless setup, so false
// would mean every new thread starts with the server switched off.
const mcpDefaultEnabled = true

// McpConnectResult is the dashboard-facing result of one connect attempt.
type McpConnectResult struct {
	OK         bool   `json:"ok"`
	ModuleID   string `json:"module_id,omitempty"`
	Name       string `json:"name,omitempty"`
	Icon       string `json:"icon,omitempty"`
	ServerURL  string `json:"server_url,omitempty"`
	ToolsCount int    `json:"tools_count"`
	Error      string `json:"error,omitempty"`
}

// mcpConnectRequest is the dashboard -> server payload.
type mcpConnectRequest struct {
	TokenV2     string `json:"token_v2"`
	UserID      string `json:"user_id"`
	SpaceID     string `json:"space_id"`
	SpaceViewID string `json:"space_view_id"`
	ServerURL   string `json:"server_url"`
	HeaderName  string `json:"header_name"`
	HeaderValue string `json:"header_value"`
	Name        string `json:"name"`
	Icon        string `json:"icon"`
}

// agentChatModulePointer is one entry of space_view.settings.agent_chat_modules.
type agentChatModulePointer struct {
	Pointer struct {
		Table   string `json:"table"`
		ID      string `json:"id"`
		SpaceID string `json:"spaceId"`
	} `json:"pointer"`
	DefaultEnabled bool `json:"defaultEnabled"`
}

// mcpSpaceViewValue is the slice of a space_view record we care about.
type mcpSpaceViewValue struct {
	Settings struct {
		AgentChatModules []agentChatModulePointer `json:"agent_chat_modules"`
	} `json:"settings"`
}

// HandleMcpConnect serves POST /admin/mcp/connect.
func HandleMcpConnect(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !chatAuthOK(auth, w, r) {
			return
		}

		var body mcpConnectRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			mcpWriteResult(w, http.StatusBadRequest, McpConnectResult{Error: "invalid request body"})
			return
		}
		body.TokenV2 = strings.TrimSpace(body.TokenV2)
		body.UserID = strings.TrimSpace(body.UserID)
		body.SpaceID = strings.TrimSpace(body.SpaceID)
		body.SpaceViewID = strings.TrimSpace(body.SpaceViewID)
		body.ServerURL = strings.TrimSpace(body.ServerURL)
		body.HeaderName = strings.TrimSpace(body.HeaderName)
		body.HeaderValue = strings.TrimSpace(body.HeaderValue)
		body.Name = strings.TrimSpace(body.Name)
		body.Icon = strings.TrimSpace(body.Icon)

		if body.TokenV2 == "" || body.SpaceID == "" || body.ServerURL == "" {
			mcpWriteResult(w, http.StatusBadRequest, McpConnectResult{Error: "token_v2, space_id and server_url are required"})
			return
		}
		if body.UserID == "" {
			mcpWriteResult(w, http.StatusBadRequest, McpConnectResult{Error: "user_id is required (re-run workspace discovery)"})
			return
		}
		low := strings.ToLower(body.ServerURL)
		if !strings.HasPrefix(low, "http://") && !strings.HasPrefix(low, "https://") {
			mcpWriteResult(w, http.StatusBadRequest, McpConnectResult{Error: "server_url must start with http:// or https://"})
			return
		}
		if body.HeaderValue != "" && body.HeaderName == "" {
			body.HeaderName = "Authorization"
		}
		if body.Icon == "" {
			body.Icon = mcpDefaultIcon
		}

		shortID := truncate(body.SpaceID, 8)
		authHeaders := mcpAuthHeaders(body.HeaderName, body.HeaderValue)

		// 1. Handshake. Also yields the tool list and the server's own name.
		profile, err := mcpValidateServer(body.TokenV2, body.UserID, body.SpaceID, body.ServerURL, authHeaders)
		if mcpBlockedByPolicy(err) {
			// A freshly created workspace ships with custom MCP servers switched
			// off, so its very first handshake always 403s. The token driving this
			// request belongs to the workspace owner - exactly the person the
			// error says to go ask - so lift the block and try once more.
			changed, ferr := allowCustomMcpServers(body.TokenV2, body.UserID, body.SpaceID)
			switch {
			case ferr != nil:
				log.Printf("[mcp-connect] %s could not enable custom MCP servers: %v", shortID, ferr)
			case len(changed) == 0:
				log.Printf("[mcp-connect] %s refused custom MCP servers, yet every switch already read as open", shortID)
			default:
				log.Printf("[mcp-connect] %s custom MCP servers were disabled, relaxed: %s", shortID, strings.Join(changed, ", "))
				// The settings write is a transaction; give it a breath to land
				// before the retry reads the policy again.
				time.Sleep(600 * time.Millisecond)
				profile, err = mcpValidateServer(body.TokenV2, body.UserID, body.SpaceID, body.ServerURL, authHeaders)
			}
		}
		if err != nil {
			log.Printf("[mcp-connect] %s validate failed: %v", shortID, err)
			mcpWriteResult(w, http.StatusBadGateway, McpConnectResult{Error: mcpConnectErrorText(err, len(authHeaders) > 0)})
			return
		}

		name := body.Name
		if name == "" {
			name = strings.TrimSpace(profile.OfficialName)
		}
		if name == "" {
			name = mcpNameFromURL(body.ServerURL)
		}

		moduleID := wsNewUUID()

		// 2. Write the workflow_module record.
		if err := mcpCreateModule(body.TokenV2, body.UserID, body.SpaceID, moduleID, body.ServerURL, name, body.Icon, profile.Tools); err != nil {
			log.Printf("[mcp-connect] %s create module failed: %v", shortID, err)
			mcpWriteResult(w, http.StatusBadGateway, McpConnectResult{Error: err.Error()})
			return
		}

		// 3. Store the secret and flip the connection to "connected".
		if err := mcpServerConnect(body.TokenV2, body.UserID, body.SpaceID, moduleID, authHeaders); err != nil {
			log.Printf("[mcp-connect] %s connect failed: %v", shortID, err)
			mcpWriteResult(w, http.StatusBadGateway, McpConnectResult{Error: err.Error()})
			return
		}

		// 4. Link it into the space's chat modules. Not a nicety: the chat client
		// builds its MCP list out of space_view.settings.agent_chat_modules, so a
		// module that never lands there is invisible to the agent even though its
		// connection is live. The dashboard does not always know the space_view
		// id, so resolve it instead of skipping the step in silence.
		spaceViewID := body.SpaceViewID
		if spaceViewID == "" {
			resolved, rerr := mcpResolveSpaceViewID(body.TokenV2, body.UserID, body.SpaceID)
			if rerr != nil {
				log.Printf("[mcp-connect] %s could not resolve space_view: %v", shortID, rerr)
			} else {
				spaceViewID = resolved
				log.Printf("[mcp-connect] %s resolved space_view %s", shortID, truncate(spaceViewID, 8))
			}
		}
		if spaceViewID == "" {
			mcpWriteResult(w, http.StatusBadGateway, McpConnectResult{
				ModuleID:   moduleID,
				Name:       name,
				Icon:       body.Icon,
				ServerURL:  body.ServerURL,
				ToolsCount: len(profile.Tools),
				Error:      "Сервер подключён, но не попал в список модулей чата: не удалось найти space_view воркспейса. Агент его не увидит.",
			})
			return
		}
		if err := mcpAttachModule(body.TokenV2, body.UserID, body.SpaceID, spaceViewID, moduleID); err != nil {
			log.Printf("[mcp-connect] %s attach to space_view failed: %v", shortID, err)
			mcpWriteResult(w, http.StatusBadGateway, McpConnectResult{
				ModuleID:   moduleID,
				Name:       name,
				Icon:       body.Icon,
				ServerURL:  body.ServerURL,
				ToolsCount: len(profile.Tools),
				Error:      "Сервер подключён, но не попал в список модулей чата: " + err.Error(),
			})
			return
		}

		// 5. Switch on automatic tool runs. The web client writes these flags as
		// soon as the server is added; without them the agent has the tools but
		// every call waits for a confirmation click nobody is there to give.
		if err := mcpFinalizeModule(body.TokenV2, body.UserID, body.SpaceID, moduleID, body.ServerURL, name, body.Icon, profile); err != nil {
			log.Printf("[mcp-connect] %s tool permissions failed: %v", shortID, err)
		}

		log.Printf("[mcp-connect] %s connected %q (%s, %d tools)", shortID, name, body.ServerURL, len(profile.Tools))
		mcpWriteResult(w, http.StatusOK, McpConnectResult{
			OK:         true,
			ModuleID:   moduleID,
			Name:       name,
			Icon:       body.Icon,
			ServerURL:  body.ServerURL,
			ToolsCount: len(profile.Tools),
		})
	}
}

func mcpWriteResult(w http.ResponseWriter, status int, res McpConnectResult) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(res)
}

// mcpConnectErrorText explains a failed handshake in terms the operator can act
// on. "Authentication failed" means two completely different things depending on
// whether a token was sent at all, and the raw JSON hides that difference.
func mcpConnectErrorText(err error, sentToken bool) string {
	if err == nil {
		return ""
	}
	low := strings.ToLower(err.Error())
	authFailed := strings.Contains(low, "\"type\":\"auth\"") || strings.Contains(low, "authentication failed")
	if authFailed && !sentToken {
		return "MCP-серверу нужен токен, а поле авторизации ушло пустым. Notion не отдаёт ранее сохранённые токены, поэтому для нового воркспейса токен надо вставить руками."
	}
	if authFailed {
		return "MCP-сервер отклонил токен: он мог быть отозван или скопирован не полностью. Ответ сервера: " + err.Error()
	}
	return mcpFriendlyError(err)
}

// mcpKnownAuthSchemes are the prefixes an Authorization value may already
// carry. A value starting with none of them is treated as a bare token.
var mcpKnownAuthSchemes = []string{"bearer ", "basic ", "token ", "apikey ", "api-key ", "digest ", "negotiate ", "oauth "}

// mcpNormalizeAuthValue makes a pasted token look exactly like the value the
// Notion web client sends. A HAR of a working connection carries
//
//	{"name":"Authorization","value":"Bearer <token>"}
//
// so a value pasted without the scheme has to be given one. Without it the MCP
// server receives a naked token and answers "Authentication failed", which is
// indistinguishable from a wrong token and sends everybody hunting the wrong
// bug. Only Authorization is touched - the format of a custom header is the
// server's own business.
func mcpNormalizeAuthValue(name, value string) string {
	v := strings.TrimSpace(value)
	if v == "" || !strings.EqualFold(strings.TrimSpace(name), "Authorization") {
		return v
	}
	// Tolerate pasting the whole header line, not just its value.
	if strings.HasPrefix(strings.ToLower(v), "authorization:") {
		v = strings.TrimSpace(v[len("authorization:"):])
	}
	low := strings.ToLower(v)
	for _, scheme := range mcpKnownAuthSchemes {
		if strings.HasPrefix(low, scheme) {
			return v
		}
	}
	return "Bearer " + v
}

// mcpAuthHeaders builds the authHeaders array Notion forwards to the server.
func mcpAuthHeaders(name, value string) []map[string]string {
	headers := []map[string]string{}
	if name == "" {
		name = "Authorization"
	}
	v := mcpNormalizeAuthValue(name, value)
	if v == "" {
		return headers
	}
	return append(headers, map[string]string{"name": name, "value": v})
}

// mcpNameFromURL falls back to the host name when the server reports none.
func mcpNameFromURL(raw string) string {
	s := raw
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	if s = strings.TrimSpace(s); s == "" {
		return "MCP"
	}
	return s
}

// mcpServerProfile is everything the handshake reveals about a server. Notion
// echoes all of it back onto the module record, so it travels together.
type mcpServerProfile struct {
	OfficialName       string
	Tools              []json.RawMessage
	ServerInstructions string
	PreferredTransport string
}

// mcpValidateServer performs the MCP handshake and returns the server's
// reported name, its tool list (stored verbatim on the module record), the
// instructions it advertises and the transport it prefers.
func mcpValidateServer(tokenV2, userID, spaceID, serverURL string, authHeaders []map[string]string) (mcpServerProfile, error) {
	reqBody, err := json.Marshal(map[string]interface{}{
		"serverUrl":   serverURL,
		"spaceId":     spaceID,
		"authHeaders": authHeaders,
	})
	if err != nil {
		return mcpServerProfile{}, fmt.Errorf("encode validateMcpConnection body: %w", err)
	}

	resp, err := notionChatRequest(tokenV2, userID, spaceID, "validateMcpConnection", reqBody, "application/json", chatAPITimeout())
	if err != nil {
		return mcpServerProfile{}, fmt.Errorf("validateMcpConnection failed: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return mcpServerProfile{}, fmt.Errorf("validateMcpConnection %d: %s", resp.StatusCode, truncate(string(data), 240))
	}

	var out struct {
		Success            bool              `json:"success"`
		OfficialName       string            `json:"officialName"`
		Tools              []json.RawMessage `json:"tools"`
		ServerInstructions string            `json:"serverInstructions"`
		PreferredTransport string            `json:"preferredTransport"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return mcpServerProfile{}, fmt.Errorf("parse validateMcpConnection: %w", err)
	}
	if !out.Success {
		return mcpServerProfile{}, fmt.Errorf("MCP server rejected the handshake: %s", truncate(string(data), 240))
	}
	return mcpServerProfile{
		OfficialName:       out.OfficialName,
		Tools:              out.Tools,
		ServerInstructions: out.ServerInstructions,
		PreferredTransport: out.PreferredTransport,
	}, nil
}

// mcpSaveTransaction posts one saveTransactionsFanout operation.
func mcpSaveTransaction(tokenV2, userID, spaceID, userAction string, op map[string]interface{}) error {
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
				"operations": []map[string]interface{}{op},
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

// mcpCreateModule writes the workflow_module record describing the server.
func mcpCreateModule(tokenV2, userID, spaceID, moduleID, serverURL, name, icon string, tools []json.RawMessage) error {
	if tools == nil {
		tools = []json.RawMessage{}
	}
	now := time.Now().UnixMilli()
	op := map[string]interface{}{
		"pointer": map[string]string{
			"table":   "workflow_module",
			"id":      moduleID,
			"spaceId": spaceID,
		},
		"path":    []string{},
		"command": "set",
		"args": map[string]interface{}{
			"alive":                true,
			"created_by_id":        userID,
			"created_by_table":     "notion_user",
			"created_time":         now,
			"id":                   moduleID,
			"last_edited_by_id":    userID,
			"last_edited_by_table": "notion_user",
			"last_edited_time":     now,
			"parent_id":            userID,
			"parent_table":         "notion_user",
			"version":              1,
			"module_type":          "mcpServer",
			"space_id":             spaceID,
			"data": map[string]interface{}{
				"serverUrl": serverURL,
				"tools":     tools,
				"icon":      icon,
				"id":        moduleID,
				"name":      name,
			},
		},
	}
	return mcpSaveTransaction(tokenV2, userID, spaceID, "agentPersistenceHelpers.createAgentChatModule", op)
}

// mcpServerConnect hands the auth headers to Notion, which stores them as the
// connection secret and performs its own server-side handshake.
func mcpServerConnect(tokenV2, userID, spaceID, moduleID string, authHeaders []map[string]string) error {
	reqBody, err := json.Marshal(map[string]interface{}{
		"integrationId":     moduleID,
		"spaceId":           spaceID,
		"authHeaders":       authHeaders,
		"initiationContext": "connect",
	})
	if err != nil {
		return fmt.Errorf("encode postWorkflowsMcpServerConnect body: %w", err)
	}

	resp, err := notionChatRequest(tokenV2, userID, spaceID, "postWorkflowsMcpServerConnect", reqBody, "application/json", chatAPITimeout())
	if err != nil {
		return fmt.Errorf("postWorkflowsMcpServerConnect failed: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("postWorkflowsMcpServerConnect %d: %s", resp.StatusCode, truncate(string(data), 240))
	}
	return nil
}

// mcpExistingModules reads space_view.settings.agent_chat_modules so the new
// module can be appended instead of replacing whatever is already there.
func mcpExistingModules(tokenV2, userID, spaceID, spaceViewID string) []agentChatModulePointer {
	raw, err := syncRecordValues(tokenV2, userID, spaceID, []map[string]string{
		{"table": "space_view", "id": spaceViewID, "spaceId": spaceID},
	})
	if err != nil {
		log.Printf("[mcp-connect] %s read space_view failed: %v", truncate(spaceID, 8), err)
		return nil
	}

	var out struct {
		RecordMap struct {
			SpaceView map[string]json.RawMessage `json:"space_view"`
		} `json:"recordMap"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}

	rec, ok := out.RecordMap.SpaceView[spaceViewID]
	if !ok {
		for _, v := range out.RecordMap.SpaceView {
			rec = v
			break
		}
	}
	if len(rec) == 0 {
		return nil
	}

	// Records arrive as {"value":{...}} and sometimes {"value":{"value":{...}}}.
	var outer struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(rec, &outer); err != nil || len(outer.Value) == 0 {
		return nil
	}
	payload := outer.Value
	var nested struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(payload, &nested); err == nil && len(nested.Value) > 0 {
		payload = nested.Value
	}

	var sv mcpSpaceViewValue
	if err := json.Unmarshal(payload, &sv); err != nil {
		return nil
	}
	return sv.Settings.AgentChatModules
}

// mcpAttachModule appends the module to space_view.settings.agent_chat_modules.
func mcpAttachModule(tokenV2, userID, spaceID, spaceViewID, moduleID string) error {
	modules := mcpExistingModules(tokenV2, userID, spaceID, spaceViewID)
	for _, m := range modules {
		if strings.EqualFold(strings.TrimSpace(m.Pointer.ID), moduleID) {
			return nil
		}
	}

	var entry agentChatModulePointer
	entry.Pointer.Table = "workflow_module"
	entry.Pointer.ID = moduleID
	entry.Pointer.SpaceID = spaceID
	entry.DefaultEnabled = mcpDefaultEnabled
	modules = append(modules, entry)

	op := map[string]interface{}{
		"pointer": map[string]string{
			"table":   "space_view",
			"id":      spaceViewID,
			"spaceId": spaceID,
		},
		"path":    []string{"settings"},
		"command": "update",
		"args": map[string]interface{}{
			"agent_chat_modules": modules,
		},
	}
	return mcpSaveTransaction(tokenV2, userID, spaceID, "agentPersistenceHelpers.addAgentChatModule", op)
}

// mcpResolveSpaceViewID finds the caller's space_view for one space. The chat
// client reads its MCP list from space_view.settings.agent_chat_modules, so a
// connect that does not know the space_view id cannot finish the job - and the
// dashboard does not always carry one. user_root holds the very same pointer
// list the web client works from.
func mcpResolveSpaceViewID(tokenV2, userID, spaceID string) (string, error) {
	raw, err := syncRecordValues(tokenV2, userID, spaceID, []map[string]string{
		{"table": "user_root", "id": userID},
	})
	if err != nil {
		return "", fmt.Errorf("read user_root: %w", err)
	}

	var out struct {
		RecordMap struct {
			UserRoot map[string]json.RawMessage `json:"user_root"`
		} `json:"recordMap"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("parse user_root: %w", err)
	}

	type spaceViewPointer struct {
		SpaceID string `json:"spaceId"`
		ID      string `json:"id"`
	}
	// Records arrive as {"value":{...}} and sometimes {"value":{"value":{...}}}.
	readPointers := func(rec json.RawMessage) []spaceViewPointer {
		if len(rec) == 0 {
			return nil
		}
		var ur struct {
			Value struct {
				Value *struct {
					SpaceViewPointers []spaceViewPointer `json:"space_view_pointers"`
				} `json:"value"`
				SpaceViewPointers []spaceViewPointer `json:"space_view_pointers"`
			} `json:"value"`
		}
		if err := json.Unmarshal(rec, &ur); err != nil {
			return nil
		}
		if ur.Value.Value != nil {
			return ur.Value.Value.SpaceViewPointers
		}
		return ur.Value.SpaceViewPointers
	}

	pointers := readPointers(out.RecordMap.UserRoot[userID])
	if len(pointers) == 0 {
		for _, rec := range out.RecordMap.UserRoot {
			if p := readPointers(rec); len(p) > 0 {
				pointers = p
				break
			}
		}
	}
	for _, p := range pointers {
		if strings.EqualFold(strings.TrimSpace(p.SpaceID), spaceID) && strings.TrimSpace(p.ID) != "" {
			return strings.TrimSpace(p.ID), nil
		}
	}
	return "", fmt.Errorf("space %s has no space_view in user_root", truncate(spaceID, 8))
}

// mcpFinalizeModule replays the fifth call of the web client's connect flow: it
// merges the two "run tools automatically" switches into the module record.
// Notion's own UI writes them the moment a server is added. Without them the
// agent sees the tools but every call parks itself waiting for a confirmation
// click, which nothing in a headless setup will ever deliver. The command is an
// update on data, so everything Notion filled in during step 3
// (connectionPointer, capabilitySummary, ...) survives untouched.
func mcpFinalizeModule(tokenV2, userID, spaceID, moduleID, serverURL, name, icon string, profile mcpServerProfile) error {
	tools := profile.Tools
	if tools == nil {
		tools = []json.RawMessage{}
	}
	data := map[string]interface{}{
		"id":                         moduleID,
		"icon":                       icon,
		"name":                       name,
		"tools":                      tools,
		"serverUrl":                  serverURL,
		"runReadToolsAutomatically":  true,
		"runWriteToolsAutomatically": true,
	}
	if v := strings.TrimSpace(profile.OfficialName); v != "" {
		data["officialName"] = v
	}
	if v := strings.TrimSpace(profile.PreferredTransport); v != "" {
		data["preferredTransport"] = v
	}
	if profile.ServerInstructions != "" {
		data["serverInstructions"] = profile.ServerInstructions
	}
	op := map[string]interface{}{
		"pointer": map[string]string{
			"table":   "workflow_module",
			"id":      moduleID,
			"spaceId": spaceID,
		},
		"path":    []string{"data"},
		"command": "update",
		"args":    data,
	}
	return mcpSaveTransaction(tokenV2, userID, spaceID, "ConnectionSurfaceTabs.updateMcpToolPermissions", op)
}
