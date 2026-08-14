package proxy

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// chat_confirm.go teaches the chat to show the agent asking for permission and
// to resume the turn once the user approves it.
//
// What Notion itself does (capture app.notion.com_Archive [26-08-14 17-40-44]):
//   - a tool call the agent is not allowed to run on its own is parked in the
//     transcript with state "confirmation:requested" and the reason inline:
//     "pendingConfirmations": {"type":"urlSafety","urls":["https://..."]}
//   - the web client renders a card and, when the user clicks Allow, it fires a
//     NEW runInferenceTranscript for the SAME threadId with
//     "confirmToolStepIds": ["<tool step id>"] plus a partial transcript holding
//     the config + context steps and that pending tool step. The agent then
//     carries on inside the very same turn.
//
// The dashboard needs three things, all of them here or wired from here:
//  1. spot the pending request in the patch stream / record map
//     (parseConfirmStep, pendingConfirmFromStream);
//  2. show it: the stream gets an extra {"event":"confirm"} row, and both the
//     final "done" event and the rebuilt history carry the same object, so the
//     card is still there after a reload (chatHistMsg.Confirm);
//  3. confirm it: HandleChatConfirm replays the resume request and streams the
//     rest of the turn exactly like HandleChatStream.

// confirmationRequestedState is the state Notion parks a step in while it waits
// for the user. Any other state (or a step that already carries output) means
// nothing is pending any more.
const confirmationRequestedState = "confirmation:requested"

// chatConfirm is one permission request waiting for the user. StepID is the
// thread_message id that goes back as confirmToolStepIds; Tool/Server/Input say
// what exactly is being approved, Type/URLs carry the reason ("urlSafety" plus
// the links the agent wants to open).
type chatConfirm struct {
	StepID    string   `json:"id"`
	Type      string   `json:"type,omitempty"`
	Tool      string   `json:"tool,omitempty"`
	Server    string   `json:"server,omitempty"`
	URLs      []string `json:"urls,omitempty"`
	Input     string   `json:"input,omitempty"`
	Confirmed bool     `json:"confirmed"`
}

// parsePendingConfirmations decodes step.pendingConfirmations. The capture holds
// a single object, but a list of them is accepted too.
func parsePendingConfirmations(raw json.RawMessage) (kind string, urls []string) {
	if !isMeaningful(raw) {
		return "", nil
	}
	type pending struct {
		Type string   `json:"type"`
		URLs []string `json:"urls"`
	}
	var one pending
	if json.Unmarshal(raw, &one) == nil && (one.Type != "" || len(one.URLs) > 0) {
		return one.Type, one.URLs
	}
	var many []pending
	if json.Unmarshal(raw, &many) == nil {
		for _, p := range many {
			if kind == "" {
				kind = p.Type
			}
			urls = append(urls, p.URLs...)
		}
	}
	return kind, urls
}

// parseConfirmStep returns the permission request of one transcript step, or nil
// when that step is not waiting for anything.
func parseConfirmStep(s tmStep) *chatConfirm {
	if strings.TrimSpace(s.State) != confirmationRequestedState {
		return nil
	}
	id := strings.TrimSpace(s.ID)
	if id == "" {
		return nil
	}
	view := parseToolResultStep(s)
	kind, urls := parsePendingConfirmations(s.PendingConfirmations)
	return &chatConfirm{
		StepID: id,
		Type:   kind,
		Tool:   view.Tool,
		Server: view.Server,
		URLs:   urls,
		Input:  view.Input,
	}
}

// pendingConfirm is the live counterpart of parseConfirmStep: sMeta is what
// processStreamLine keeps per transcript entry while the turn is still running.
func (m sMeta) pendingConfirm() *chatConfirm {
	if strings.TrimSpace(m.state) != confirmationRequestedState || strings.TrimSpace(m.id) == "" {
		return nil
	}
	return &chatConfirm{
		StepID: m.id,
		Type:   m.confirmType,
		Tool:   m.label,
		Server: m.server,
		URLs:   m.confirmURLs,
		Input:  m.input,
	}
}

// parseStepFieldPath parses "/s/<idx>/<field>" (e.g. "/s/7/state") into the index
// of the transcript step and the patched field. Deeper paths such as
// "/s/7/value/0/content" are text deltas, not step fields, and are rejected.
func parseStepFieldPath(p string) (int, string, bool) {
	if !strings.HasPrefix(p, "/s/") {
		return 0, "", false
	}
	parts := strings.Split(strings.Trim(p, "/"), "/")
	if len(parts) != 3 {
		return 0, "", false
	}
	idx, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, "", false
	}
	return idx, parts[2], true
}

// emitConfirm sends the live "confirm" row. Notion keeps the inference stream
// open while it waits for the user, so without this row the browser would just
// spin until the lease expired.
func emitConfirm(emit func(map[string]interface{}), c *chatConfirm) {
	if c == nil {
		return
	}
	emit(map[string]interface{}{"event": "confirm", "confirm": c})
}

// pendingConfirmFromStream scans the whole ndjson of one turn and returns the
// request that is still waiting when the stream ends. A step arrives either in a
// record-map line, in the patch-start snapshot or appended by a patch op, and
// its state may flip later on - all of it is folded in, and a step that moved on
// (state changed, or output arrived) stops being pending.
func pendingConfirmFromStream(raw []byte) *chatConfirm {
	var items []tmStep
	var order []string
	pending := map[string]*chatConfirm{}
	record := func(s tmStep) {
		id := strings.TrimSpace(s.ID)
		if id == "" {
			return
		}
		if c := parseConfirmStep(s); c != nil {
			if _, seen := pending[id]; !seen {
				order = append(order, id)
			}
			pending[id] = c
			return
		}
		if strings.TrimSpace(s.State) != "" || isMeaningful(s.Output) || isMeaningful(s.Result) {
			delete(pending, id)
		}
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var probe struct {
			Type string `json:"type"`
		}
		if json.Unmarshal([]byte(line), &probe) != nil {
			continue
		}
		switch probe.Type {
		case "patch-start":
			var ps struct {
				Data struct {
					S []json.RawMessage `json:"s"`
				} `json:"data"`
			}
			if json.Unmarshal([]byte(line), &ps) != nil {
				continue
			}
			for _, it := range ps.Data.S {
				var s tmStep
				_ = json.Unmarshal(it, &s)
				items = append(items, s)
				record(s)
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
				if op.O == "a" && strings.HasSuffix(op.P, "/s/-") {
					var s tmStep
					_ = json.Unmarshal(op.V, &s)
					items = append(items, s)
					record(s)
					continue
				}
				idx, field, ok := parseStepFieldPath(op.P)
				if !ok || idx >= len(items) {
					continue
				}
				switch field {
				case "state":
					var st string
					if json.Unmarshal(op.V, &st) == nil {
						items[idx].State = st
					}
				case "pendingConfirmations":
					items[idx].PendingConfirmations = op.V
				case "output":
					items[idx].Output = op.V
				case "result":
					items[idx].Result = op.V
				default:
					continue
				}
				record(items[idx])
			}
		case "record-map":
			var rmLine struct {
				RecordMap recordMapShape `json:"recordMap"`
				V         struct {
					RecordMap     recordMapShape   `json:"recordMap"`
					ThreadMessage threadMessageMap `json:"thread_message"`
				} `json:"v"`
				Value struct {
					RecordMap     recordMapShape   `json:"recordMap"`
					ThreadMessage threadMessageMap `json:"thread_message"`
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
				for _, m := range sortedThreadMessages(c) {
					record(m.step)
				}
			}
		}
	}
	for i := len(order) - 1; i >= 0; i-- {
		if c, ok := pending[order[i]]; ok {
			return c
		}
	}
	return nil
}

// chatConfirmBody is the /admin/chat/confirm request: which thread is waiting
// plus the tool step ids the user just approved.
type chatConfirmBody struct {
	TokenV2     string   `json:"token_v2"`
	UserID      string   `json:"user_id"`
	SpaceID     string   `json:"space_id"`
	ThreadID    string   `json:"thread_id"`
	Agent       string   `json:"agent"`
	ToolStepIDs []string `json:"tool_step_ids"`
}

// fetchConfirmSteps reads the parked steps back from Notion so the resume request
// can carry them verbatim, the way the web client carries its local copy.
// Failing to read them is not fatal: the thread already holds every step and
// isPartialTranscript tells Notion to fill in the rest itself.
func fetchConfirmSteps(tokenV2, userID, spaceID string, ids []string) []json.RawMessage {
	if len(ids) == 0 {
		return nil
	}
	pointers := make([]map[string]string, 0, len(ids))
	for _, id := range ids {
		pointers = append(pointers, map[string]string{"table": "thread_message", "id": id, "spaceId": spaceID})
	}
	data, err := syncRecordValues(tokenV2, userID, spaceID, pointers)
	if err != nil {
		return nil
	}
	var wrap struct {
		RecordMap struct {
			ThreadMessage map[string]struct {
				Value struct {
					Value struct {
						Step json.RawMessage `json:"step"`
					} `json:"value"`
				} `json:"value"`
			} `json:"thread_message"`
		} `json:"recordMap"`
	}
	if json.Unmarshal(data, &wrap) != nil {
		return nil
	}
	out := make([]json.RawMessage, 0, len(ids))
	for _, id := range ids {
		rec, ok := wrap.RecordMap.ThreadMessage[id]
		if !ok || !isMeaningful(rec.Value.Value.Step) {
			continue
		}
		out = append(out, rec.Value.Value.Step)
	}
	return out
}

// HandleChatConfirm approves the tool calls the agent asked about and streams the
// rest of the turn. It mirrors the capture: same threadId, no new thread, a
// partial transcript plus confirmToolStepIds.
func HandleChatConfirm(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !chatAuthOK(auth, w, r) {
			return
		}
		var body chatConfirmBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		body.TokenV2 = strings.TrimSpace(body.TokenV2)
		body.SpaceID = strings.TrimSpace(body.SpaceID)
		body.ThreadID = strings.TrimSpace(body.ThreadID)
		ids := make([]string, 0, len(body.ToolStepIDs))
		for _, id := range body.ToolStepIDs {
			if s := strings.TrimSpace(id); s != "" {
				ids = append(ids, s)
			}
		}
		if body.TokenV2 == "" || body.SpaceID == "" || body.ThreadID == "" || len(ids) == 0 {
			http.Error(w, `{"error":"token_v2, space_id, thread_id and tool_step_ids are required"}`, http.StatusBadRequest)
			return
		}

		// Resuming is a fresh inference, so it needs the same one-turn overage
		// window as a plain message.
		defer armOverageForTurn(body.TokenV2, body.UserID, body.SpaceID)()

		createdSource := "ai_module"
		if body.Agent != "" && body.Agent != "default" {
			createdSource = "custom_agent"
		}

		transcript := []interface{}{}
		for _, step := range fetchConfirmSteps(body.TokenV2, body.UserID, body.SpaceID, ids) {
			transcript = append(transcript, step)
		}

		payload := map[string]interface{}{
			"traceId":      generateUUIDv4(),
			"spaceId":      body.SpaceID,
			"transcript":   transcript,
			"threadId":     body.ThreadID,
			"createThread": false,
			"debugOverrides": map[string]interface{}{
				"emitAgentSearchExtractedResults": true,
				"cachedInferences":                map[string]interface{}{},
				"annotationInferences":            map[string]interface{}{},
				"emitInferences":                  false,
			},
			"generateTitle":           false,
			"saveAllThreadOperations": true,
			"setUnreadState":          true,
			// The whole point of this call.
			"confirmToolStepIds":  ids,
			"createdSource":       createdSource,
			"threadType":          "workflow",
			"isPartialTranscript": true,
			// The web client asks for a plain response here, but every parser in
			// this proxy speaks the patch protocol, so we keep asking for patches.
			"asPatchResponse":                        true,
			"patchResponseVersion":                   2,
			"isUserInAnySalesAssistedSpace":          false,
			"isSpaceSalesAssisted":                   false,
			"supportsCustomAgentNudgeTranscriptStep": true,
		}
		streamInference(w, body.TokenV2, body.UserID, body.SpaceID, body.ThreadID, payload)
	}
}
