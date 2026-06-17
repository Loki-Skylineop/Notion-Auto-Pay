package proxy

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

// chat.go proxies the private Notion AI chat protocol (runInferenceTranscript +
// the thread/agent listing endpoints) using each workspace account's token_v2
// cookie. It powers the dashboard "Чат" tab: pick a workspace, pick an agent
// (the built-in assistant or a custom agent), start a new chat or continue an
// existing thread, and stream the assistant reply.
//
// The request/response shapes were reverse-engineered from the real web client
// (chat.com.har). Key facts:
//   - runInferenceTranscript returns an application/x-ndjson patch stream. The
//     final assistant text lives in the closing record-map under
//     thread_message -> step(type="agent-inference") -> value[] where each part
//     is {type:"thinking"|"text", content}. We keep only the "text" parts.
//   - A custom agent uses threadParentPointer{table:"workflow",id:workflowId}
//     with config.isCustomAgent=true and surface="custom_agent". The built-in
//     assistant uses threadParentPointer{table:"space",id:spaceId},
//     config.isCustomAgent=false, modelFromUser=true and surface="ai_module".
//   - Continuing a thread re-sends config+context+the new user turn with
//     createThread=false, isPartialTranscript=true and no threadParentPointer;
//     the server already holds the prior turns for threadId.

// notionChatRequest issues a POST to a private Notion API endpoint authenticated
// with the account's token_v2 cookie, mirroring the headers the real web client
// sends. accept negotiates the response type ("application/x-ndjson" for the
// streaming runInferenceTranscript endpoint, "application/json" otherwise).
func notionChatRequest(tokenV2, userID, spaceID, path string, body []byte, accept string, timeout time.Duration) (*http.Response, error) {
	client := getChromeHTTPClient(timeout)
	req, err := http.NewRequest("POST", NotionAPIBase+"/"+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if accept == "" {
		accept = "application/json"
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", accept)
	req.Header.Set("Cookie", "token_v2="+tokenV2)
	if AppConfig != nil {
		req.Header.Set("User-Agent", AppConfig.Browser.UserAgent)
	}
	if userID != "" {
		req.Header.Set("x-notion-active-user-header", userID)
	}
	if spaceID != "" {
		req.Header.Set("x-notion-space-id", spaceID)
	}
	req.Header.Set("notion-client-version", DefaultClientVersion)
	req.Header.Set("notion-audit-log-platform", "web")
	return client.Do(req)
}

// chatAuthOK enforces POST + dashboard session (when a password is configured).
func chatAuthOK(auth *DashboardAuth, w http.ResponseWriter, r *http.Request) bool {
	if r.Method != "POST" {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return false
	}
	if auth != nil && auth.HasAdminPassword() && !auth.ValidateSession(r) {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return false
	}
	return true
}

func chatAPITimeout() time.Duration {
	if AppConfig != nil {
		if d := AppConfig.APITimeoutDuration(); d > 0 {
			return d
		}
	}
	return 30 * time.Second
}

// ---- Agents ----

type chatAgent struct {
	ID   string `json:"id"` // "default" or a workflowId
	Name string `json:"name"`
	Icon string `json:"icon,omitempty"`
	Kind string `json:"kind"` // "default" | "custom"
}

// HandleChatAgents returns the built-in assistant plus every custom agent the
// account can see in the given space. Custom agents are read from the workflow
// records embedded in getInferenceTranscriptsForUser's recordMap (the only
// place the HAR exposes them without a dedicated listing endpoint).
func HandleChatAgents(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !chatAuthOK(auth, w, r) {
			return
		}
		var body struct {
			TokenV2 string `json:"token_v2"`
			UserID  string `json:"user_id"`
			SpaceID string `json:"space_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		body.TokenV2 = strings.TrimSpace(body.TokenV2)
		body.SpaceID = strings.TrimSpace(body.SpaceID)
		if body.TokenV2 == "" || body.SpaceID == "" {
			http.Error(w, `{"error":"token_v2 and space_id are required"}`, http.StatusBadRequest)
			return
		}
		agents := []chatAgentID: "default", Name: "Обычный агент", Kind: "default"
		if custom, err := fetchCustomAgents(body.TokenV2, body.UserID, body.SpaceID); err != nil {
			log.Printf("[chat] fetch custom agents failed: %v", err)
		} else {
			agents = append(agents, custom...)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"agents": agents})
	}
}

func transcriptsRequestBody(spaceID string) []byte {
	b, _ := json.Marshal(map[string]interface{}{
		"threadParentPointer": map[string]string{"table": "space", "id": spaceID, "spaceId": spaceID},
		"includeWorkflowThreads": true,
		"includeWriterChats":     false,
	})
	return b
}

func fetchCustomAgents(tokenV2, userID, spaceID string) ([]chatAgent, error) {
	resp, err := notionChatRequest(tokenV2, userID, spaceID, "getInferenceTranscriptsForUser", transcriptsRequestBody(spaceID), "application/json", chatAPITimeout())
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("getInferenceTranscriptsForUser %d: %s", resp.StatusCode, truncate(string(data), 200))
	}
	var parsed struct {
		RecordMap struct {
			Workflow map[string]struct {
				Value struct {
					Value struct {
						ID   string `json:"id"`
						Data struct {
							Icon string `json:"icon"`
							Name string `json:"name"`
						} `json:"data"`
					} `json:"value"`
				} `json:"value"`
			} `json:"workflow"`
		} `json:"recordMap"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, err
	}
	out := make([]chatAgent, 0, len(parsed.RecordMap.Workflow))
	for _, wf := range parsed.RecordMap.Workflow {
		id := wf.Value.Value.ID
		if id == "" {
			continue
		}
		name := wf.Value.Value.Data.Name
		if name == "" {
			name = "Агент"
		}
		out = append(out, chatAgent{ID: id, Name: name, Icon: wf.Value.Value.Data.Icon, Kind: "custom"})
	}
	return out, nil
}

// ---- Threads ----

type chatThread struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
	Type      string `json:"type"`
}

// HandleChatThreads lists the account's recent chat threads in a space so the
// UI can show history and let the user continue an existing conversation.
func HandleChatThreads(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !chatAuthOK(auth, w, r) {
			return
		}
		var body struct {
			TokenV2 string `json:"token_v2"`
			UserID  string `json:"user_id"`
			SpaceID string `json:"space_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		body.TokenV2 = strings.TrimSpace(body.TokenV2)
		body.SpaceID = strings.TrimSpace(body.SpaceID)
		if body.TokenV2 == "" || body.SpaceID == "" {
			http.Error(w, `{"error":"token_v2 and space_id are required"}`, http.StatusBadRequest)
			return
		}
		resp, err := notionChatRequest(body.TokenV2, body.UserID, body.SpaceID, "getInferenceTranscriptsForUser", transcriptsRequestBody(body.SpaceID), "application/json", chatAPITimeout())
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("notion %d", resp.StatusCode)})
			return
		}
		var parsed struct {
			Transcripts []chatThread `json:"transcripts"`
		}
		json.Unmarshal(data, &parsed)
		json.NewEncoder(w).Encode(map[string]interface{}{"threads": parsed.Transcripts})
	}
}

// ---- Send ----

// buildChatConfig returns the transcript config block. The flag set is copied
// verbatim from the real web client; only the agent-type-dependent fields
// (isCustomAgent / useCustomAgentDraft / modelFromUser / workflowId) vary.
func buildChatConfig(isCustom bool, workflowID string) map[string]interface{} {
	cfg := map[string]interface{}{
		"type":                                 "workflow",
		"enableAgentAutomations":               true,
		"enableAgentIntegrations":              true,
		"enableCustomAgents":                   true,
		"enableExperimentalIntegrations":       false,
		"enableAgentDiffs":                     true,
		"enableCsvAttachmentSupport":           true,
		"showDatabaseAgentsDiscoverability":    true,
		"enableAgentThreadTools":               false,
		"enableCrdtOperations":                 false,
		"enableAgentCardCustomization":         true,
		"enableSystemPromptAsPage":             false,
		"enableUserSessionContext":             false,
		"enableLargeToolResultComputerOffload": false,
		"enableScriptAgentAdvanced":            false,
		"enableScriptAgent":                    true,
		"enableScriptAgentSearchConnectorsInCustomAgent": false,
		"enableScriptAgentGoogleDriveInCustomAgent":      false,
		"enableScriptAgentGoogleDriveOAuthInCustomAgent": false,
		"enableScriptAgentSlack":              true,
		"enableScriptAgentMcpServers":         false,
		"enableScriptAgentGtm":                false,
		"enableComputer":                      true,
		"enableCreateAndRunThread":            true,
		"enableSoftwareFactoryPage":           false,
		"enableAgentGenerateImage":            true,
		"enableQueryCalendar":                 false,
		"enableQueryMail":                     false,
		"enableMailExplicitToolCalls":         true,
		"enableMailNotificationPreferences":   false,
		"enableMailAgentMultiProviderSupport": false,
		"useRulePrioritization":               true,
		"availableConnectors":                 []interface{}{},
		"searchScopes":                        []map[string]string"type": "everything",
		"useWebSearch":                        true,
		"isHipaa":                             false,
		"internetAccess":                      false,
		"useReadOnlyMode":                     false,
		"writerMode":                          false,
		"modelFromUser":                       !isCustom,
		"isCustomAgent":                       isCustom,
		"isCustomAgentBuilder":                false,
		"isAgentResearchRequest":              false,
		"useCustomAgentDraft":                 isCustom,
		"use_draft_actor_pointer":             false,
		"enableUpdatePageAutofixer":           true,
		"enableMarkdownVNext":                 false,
		"enableEmbedBlocks":                   true,
		"updatePageStaleViewGuardEnabled":     false,
		"enableUpdatePageOrderUpdates":        true,
		"enableAgentSupportPropertyReorder":   true,
		"enableAgentAskSurvey":                true,
		"databaseAgentConfigMode":             false,
		"isOnboardingAgent":                   false,
		"isMobile":                            false,
	}
	if isCustom && workflowID != "" {
		cfg["workflowId"] = workflowID
	}
	return cfg
}

// HandleChatSend runs one chat turn: it builds the transcript (config + context
// + user message), POSTs runInferenceTranscript, parses the ndjson reply and
// returns the assistant text, the thread id and the (auto-generated) title.
func HandleChatSend(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !chatAuthOK(auth, w, r) {
			return
		}
		var body struct {
			TokenV2       string `json:"token_v2"`
			UserID        string `json:"user_id"`
			UserName      string `json:"user_name"`
			UserEmail     string `json:"user_email"`
			SpaceID       string `json:"space_id"`
			SpaceViewID   string `json:"space_view_id"`
			SpaceName     string `json:"space_name"`
			Timezone      string `json:"timezone"`
			Agent         string `json:"agent"`
			ContextPageID string `json:"context_page_id"`
			ThreadID      string `json:"thread_id"`
			Message       string `json:"message"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		body.TokenV2 = strings.TrimSpace(body.TokenV2)
		body.SpaceID = strings.TrimSpace(body.SpaceID)
		body.Message = strings.TrimSpace(body.Message)
		if body.TokenV2 == "" || body.SpaceID == "" || body.Message == "" {
			http.Error(w, `{"error":"token_v2, space_id and message are required"}`, http.StatusBadRequest)
			return
		}

		isCustom := body.Agent != "" && body.Agent != "default"
		workflowID := ""
		if isCustom {
			workflowID = body.Agent
		}
		tz := body.Timezone
		if tz == "" {
			tz = "UTC"
		}

		configMsg := map[string]interface{}{
			"id":    generateUUIDv4(),
			"type":  "config",
			"value": buildChatConfig(isCustom, workflowID),
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
			ctxVal["workflowId"] = workflowID
			if body.ContextPageID != "" {
				ctxVal["context_page_id"] = body.ContextPageID
			}
		} else {
			ctxVal["surface"] = "ai_module"
		}
		contextMsg := map[string]interface{}{
			"id":    generateUUIDv4(),
			"type":  "context",
			"value": ctxVal,
		}
		userMsg := map[string]interface{}{
			"id":        generateUUIDv4(),
			"type":      "user",
			"value":     [][]stringbody.Message,
			"userId":    body.UserID,
			"createdAt": time.Now().UnixMilli(),
		}

		newThread := strings.TrimSpace(body.ThreadID) == ""
		threadID := strings.TrimSpace(body.ThreadID)
		if newThread {
			threadID = generateUUIDv4()
		}
		createdSource := "ai_module"
		if isCustom {
			createdSource = "custom_agent"
		}

		payload := map[string]interface{}{
			"traceId":                       generateUUIDv4(),
			"spaceId":                       body.SpaceID,
			"transcript":                    []interface{}{configMsg, contextMsg, userMsg},
			"threadId":                      threadID,
			"createThread":                  newThread,
			"debugOverrides":                map[string]interface{}{},
			"generateTitle":                 true,
			"saveAllThreadOperations":       true,
			"setUnreadState":                true,
			"createdSource":                 createdSource,
			"threadType":                    "workflow",
			"isPartialTranscript":           !newThread,
			"asPatchResponse":               true,
			"patchResponseVersion":          2,
			"isUserInAnySalesAssistedSpace": false,
			"isSpaceSalesAssisted":          false,
		}
		if newThread {
			tp := map[string]string{"spaceId": body.SpaceID}
			if isCustom {
				tp["table"] = "workflow"
				tp["id"] = workflowID
			} else {
				tp["table"] = "space"
				tp["id"] = body.SpaceID
			}
			payload["threadParentPointer"] = tp
		}

		reqBody, _ := json.Marshal(payload)
		resp, err := notionChatRequest(body.TokenV2, body.UserID, body.SpaceID, "runInferenceTranscript", reqBody, "application/x-ndjson", 180*time.Second)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			log.Printf("[chat] runInferenceTranscript %d: %s", resp.StatusCode, truncate(string(raw), 300))
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("notion error %d: %s", resp.StatusCode, truncate(string(raw), 200))})
			return
		}
		text, title := parseInferenceStream(raw)
		if strings.TrimSpace(text) == "" {
			text = "(агент не вернул текстового ответа)"
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"thread_id": threadID,
			"title":     title,
			"text":      text,
		})
	}
}

// ---- ndjson parsing ----

type tmStep struct {
	Type  string          `json:"type"`
	Value json.RawMessage `json:"value"`
}

type tmRecord struct {
	Value struct {
		Value struct {
			Step tmStep `json:"step"`
		} `json:"value"`
	} `json:"value"`
}

type recordMapShape struct {
	ThreadMessage map[string]tmRecord `json:"thread_message"`
}

func extractTM(rm recordMapShape) (text, title string) {
	bestLen := -1
	for _, msg := range rm.ThreadMessage {
		step := msg.Value.Value.Step
		switch step.Type {
		case "title":
			var s string
			if json.Unmarshal(step.Value, &s) == nil && s != "" {
				title = s
			}
		case "agent-inference":
			var parts []struct {
				Type    string `json:"type"`
				Content string `json:"content"`
			}
			if json.Unmarshal(step.Value, &parts) == nil {
				var b strings.Builder
				for _, p := range parts {
					if p.Type == "text" {
						b.WriteString(p.Content)
					}
				}
				if b.Len() > bestLen {
					text = b.String()
					bestLen = b.Len()
				}
			}
		}
	}
	return text, title
}

// parseInferenceStream walks the ndjson patch stream. It prefers the final,
// authoritative record-map (which carries the complete agent-inference text);
// if no record-map is present it falls back to concatenating the streamed
// "content" deltas.
func parseInferenceStream(raw []byte) (text, title string) {
	var fallback strings.Builder
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var probe struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal([]byte(line), &probe); err != nil {
			continue
		}
		switch probe.Type {
		case "record-map":
			var rmLine struct {
				RecordMap recordMapShape `json:"recordMap"`
				V         struct {
					RecordMap     recordMapShape      `json:"recordMap"`
					ThreadMessage map[string]tmRecord `json:"thread_message"`
				} `json:"v"`
				Value struct {
					RecordMap     recordMapShape      `json:"recordMap"`
					ThreadMessage map[string]tmRecord `json:"thread_message"`
				} `json:"value"`
			}
			if json.Unmarshal([]byte(line), &rmLine) != nil {
				continue
			}
			candidates := []recordMapShape{
				rmLine.RecordMap,
				rmLine.V.RecordMap,
				{ThreadMessage: rmLine.V.ThreadMessage},
				rmLine.Value.RecordMap,
				{ThreadMessage: rmLine.Value.ThreadMessage},
			}
			for _, c := range candidates {
				if len(c.ThreadMessage) == 0 {
					continue
				}
				if t, ti := extractTM(c); true {
					if t != "" {
						text = t
					}
					if ti != "" {
						title = ti
					}
				}
			}
		case "patch":
			var patch struct {
				V []struct {
					O string          `json:"o"`
					P string          `json:"p"`
					V json.RawMessage `json:"v"`
				} `json:"v"`
			}
			if json.Unmarshal([]byte(line), &patch) != nil {
				continue
			}
			for _, op := range patch.V {
				if op.O == "x" && strings.HasSuffix(op.P, "/content") {
					var s string
					if json.Unmarshal(op.V, &s) == nil {
						fallback.WriteString(s)
					}
				} else if op.O == "a" {
					var rec struct {
						Type  string `json:"type"`
						Value string `json:"value"`
					}
					if json.Unmarshal(op.V, &rec) == nil && rec.Type == "title" && rec.Value != "" && title == "" {
						title = rec.Value
					}
				}
			}
		}
	}
	if strings.TrimSpace(text) == "" {
		text = strings.TrimSpace(fallback.String())
	}
	return text, title
}
