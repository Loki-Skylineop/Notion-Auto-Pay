package proxy

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"
	"time"
)

// chat_parse.go holds the ndjson / record-map parsing for the chat proxy plus
// the tool-call presentation helpers. Split out of chat.go to keep each file a
// manageable size.

// ---- record-map shapes ----

// notionTime accepts both shapes Notion uses for timestamps: an ISO-8601
// string and epoch milliseconds as a number. Decoding into a plain string made
// one numeric createdAt fail the whole record map (history + message edit).
type notionTime struct {
	Raw    string
	Millis int64
}

func (t *notionTime) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || string(b) == "null" {
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		t.Raw = s
		if ts, err := time.Parse(time.RFC3339Nano, s); err == nil {
			t.Millis = ts.UnixMilli()
		}
		return nil
	}
	var n json.Number
	if err := json.Unmarshal(b, &n); err != nil {
		return err
	}
	t.Raw = n.String()
	if ms, err := n.Int64(); err == nil {
		if ms < 1e12 { // seconds turn up occasionally
			ms *= 1000
		}
		t.Millis = ms
	}
	return nil
}

func (t notionTime) String() string { return t.Raw }

type tmStep struct {
	Type     string          `json:"type"`
	Value    json.RawMessage `json:"value"`
	ToolName string          `json:"toolName"`
	Input    json.RawMessage `json:"input"`
	Output   json.RawMessage `json:"output"`
	Result   json.RawMessage `json:"result"`
	// Survey steps (type=="survey") carry their definition inline on the step
	// rather than under Value: an id, the questions[] and (once answered) the
	// responses map + submitted flag.
	ID        string          `json:"id"`
	Questions json.RawMessage `json:"questions"`
	Responses json.RawMessage `json:"responses"`
	Submitted bool            `json:"submitted"`
	CreatedAt notionTime      `json:"createdAt"`
	// User-injected steps (type=="user-injected") are the user's survey answers
	// rendered back into the transcript as a pseudo user message.
	ActualMessage  json.RawMessage `json:"actualMessage"`
	DisplayMessage json.RawMessage `json:"displayMessage"`
	// Agent-inference steps may carry an editReferenceMap describing the pages
	// the agent created or edited this turn (powers the open-page cards).
	EditReferenceMap json.RawMessage `json:"editReferenceMap"`
}

type tmInner struct {
	ID             string     `json:"id"`
	CreatedTime    notionTime `json:"created_time"`
	LastEditedTime notionTime `json:"last_edited_time"`
	Step           tmStep     `json:"step"`
}

type tmRecord struct {
	Value struct {
		Value tmInner `json:"value"`
	} `json:"value"`
}

// threadMessageMap is the decoded thread_message table of a record map. Every
// record is decoded on its own, so a single message of an unexpected shape is
// skipped instead of taking the entire conversation down with it.
type threadMessageMap map[string]tmRecord

func (m *threadMessageMap) UnmarshalJSON(b []byte) error {
	raw := map[string]json.RawMessage{}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	out := make(threadMessageMap, len(raw))
	for id, item := range raw {
		var rec tmRecord
		if err := json.Unmarshal(item, &rec); err != nil {
			continue
		}
		out[id] = rec
	}
	*m = out
	return nil
}

type recordMapShape struct {
	ThreadMessage threadMessageMap `json:"thread_message"`
}

type orderedTM struct {
	created int64
	step    tmStep
}

// sortedThreadMessages returns the record-map's thread_message steps ordered by
// created_time.
func sortedThreadMessages(rm recordMapShape) []orderedTM {
	out := make([]orderedTM, 0, len(rm.ThreadMessage))
	for _, m := range rm.ThreadMessage {
		out = append(out, orderedTM{created: m.Value.Value.CreatedTime.Millis, step: m.Value.Value.Step})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].created < out[j].created })
	return out
}

// ---- survey + open-page shapes ----

// surveyOption is one selectable answer of a survey question. PageID is set when
// the option references a Notion page.
type surveyOption struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	PageID string `json:"pageId,omitempty"`
}

// surveyQuestion is one question of an agent-issued survey ("Уточню пару
// деталей…").
type surveyQuestion struct {
	ID            string         `json:"id"`
	Prompt        string         `json:"prompt"`
	Options       []surveyOption `json:"options"`
	AllowOther    bool           `json:"allowOther,omitempty"`
	AllowMultiple bool           `json:"allowMultiple,omitempty"`
}

// chatSurvey is the rendered survey attached to an assistant message. Submitted
// flips to true once the user has answered (Responses maps questionId ->
// answer, mirroring the persisted step.responses).
type chatSurvey struct {
	// NOTE: JSON keys here must match the web client (ChatSurvey in api.ts):
	// it reads `id` + `createdAt`, then sends them back as survey_step_id /
	// created_at. Emitting step_id/created_at left survey.id undefined, which
	// made the server reject the answer with "survey_step_id ... required".
	StepID    string                     `json:"id"`
	Questions []surveyQuestion           `json:"questions"`
	Responses map[string]json.RawMessage `json:"responses,omitempty"`
	Submitted bool                       `json:"submitted"`
	CreatedAt string                     `json:"createdAt,omitempty"`
}

// chatPageRef is one page the agent created/edited this turn, surfaced as an
// open-page card. Name is the editReferenceMap variable name; URL is a
// ready-to-open notion.so link.
type chatPageRef struct {
	Name   string `json:"name"`
	Label  string `json:"label,omitempty"`
	PageID string `json:"page_id"`
	URL    string `json:"url"`
	Reason string `json:"reason,omitempty"`
}

// parseSurveyStep builds a chatSurvey from a survey thread_message step.
func parseSurveyStep(s tmStep) *chatSurvey {
	if !isMeaningful(s.Questions) {
		return nil
	}
	var qs []surveyQuestion
	if json.Unmarshal(s.Questions, &qs) != nil || len(qs) == 0 {
		return nil
	}
	sv := &chatSurvey{
		StepID:    s.ID,
		Questions: qs,
		Submitted: s.Submitted,
		CreatedAt: s.CreatedAt.String(),
	}
	if isMeaningful(s.Responses) {
		var r map[string]json.RawMessage
		if json.Unmarshal(s.Responses, &r) == nil && len(r) > 0 {
			sv.Responses = r
			sv.Submitted = true
		}
	}
	return sv
}

// notionPageURL turns a 32-char (dashed or not) block/page id into a notion.so
// URL the dashboard can open in a new tab.
func notionPageURL(id string) string {
	clean := strings.ReplaceAll(strings.TrimSpace(id), "-", "")
	if clean == "" {
		return ""
	}
	return "https://www.notion.so/" + clean
}

// parseEditReferenceMap turns an agent-inference step's editReferenceMap into a
// list of open-page references. Only page parents are kept; the map key is used
// as the reference name so inline <edit_reference variableNames="…"> tags can be
// matched to a card on the frontend.
func parseEditReferenceMap(raw json.RawMessage) []chatPageRef {
	if !isMeaningful(raw) {
		return nil
	}
	var m map[string]struct {
		EditReason    string `json:"editReason"`
		ToolCallID    string `json:"toolCallId"`
		ParentsEdited []struct {
			Type          string `json:"type"`
			RecordPointer struct {
				ID    string `json:"id"`
				Table string `json:"table"`
			} `json:"recordPointer"`
		} `json:"parentsEdited"`
	}
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	names := make([]string, 0, len(m))
	for k := range m {
		names = append(names, k)
	}
	sort.Strings(names)
	var out []chatPageRef
	for _, name := range names {
		v := m[name]
		for _, p := range v.ParentsEdited {
			if p.Type != "page" {
				continue
			}
			id := strings.TrimSpace(p.RecordPointer.ID)
			if id == "" {
				continue
			}
			out = append(out, chatPageRef{
				Name:   name,
				PageID: id,
				URL:    notionPageURL(id),
				Reason: v.EditReason,
			})
			break
		}
	}
	return out
}

// parseInjectedUserText renders a user-injected step (survey answers) as plain
// text by joining its actualMessage segments (falling back to displayMessage).
func parseInjectedUserText(s tmStep) string {
	if len(s.ActualMessage) > 0 {
		if t := parseUserText(s.ActualMessage); strings.TrimSpace(t) != "" {
			return t
		}
	}
	if len(s.DisplayMessage) > 0 {
		return parseUserText(s.DisplayMessage)
	}
	return ""
}

// ---- tool-call presentation helpers ----

// serverLabel turns an MCP connector key into a display name ("github" -> "GitHub").
func serverLabel(s string) string {
	switch strings.ToLower(s) {
	case "github":
		return "GitHub"
	case "":
		return "MCP"
	default:
		return strings.ToUpper(s[:1]) + s[1:]
	}
}

func isMeaningful(raw json.RawMessage) bool {
	s := strings.TrimSpace(string(raw))
	return s != "" && s != "null" && s != "{}" && s != "[]"
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n] + "\n… (обрезано)"
	}
	return s
}

func prettyJSON(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var v interface{}
	if json.Unmarshal(raw, &v) != nil {
		return clip(strings.TrimSpace(string(raw)), 4000)
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return clip(strings.TrimSpace(string(raw)), 4000)
	}
	return clip(string(b), 4000)
}

func prettyMaybeJSON(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	var v interface{}
	if json.Unmarshal([]byte(s), &v) == nil {
		if b, err := json.MarshalIndent(v, "", "  "); err == nil {
			return clip(string(b), 4000)
		}
	}
	return clip(s, 4000)
}

// describeToolCall turns a callFunction input ({function, args}) into a human
// label, an icon hint (connector key) and the pretty-printed input arguments.
// For MCP connectors it digs into args.toolName / args.toolArguments so the
// label reads e.g. "GitHub / get_me" instead of the wrapper "runTool".
func describeToolCall(fn string, args json.RawMessage) (label, server, input string) {
	fn = strings.TrimSpace(fn)
	short := fn
	for _, p := range []string{"connections.", "adminUserConnections.", "userConnections."} {
		if strings.HasPrefix(short, p) {
			short = strings.TrimPrefix(short, p)
			break
		}
	}
	module := short
	method := ""
	if i := strings.Index(short, "."); i >= 0 {
		module = short[:i]
		method = short[i+1:]
	}
	if strings.HasPrefix(module, "mcpServer") {
		srv := strings.TrimPrefix(module, "mcpServer")
		srv = strings.TrimPrefix(srv, "_")
		server = strings.ToLower(srv)
		var a struct {
			ToolName      string          `json:"toolName"`
			ToolArguments json.RawMessage `json:"toolArguments"`
		}
		_ = json.Unmarshal(args, &a)
		if method == "listTools" {
			return serverLabel(server) + ": список инструментов", server, ""
		}
		tn := a.ToolName
		if tn == "" {
			tn = method
		}
		label = serverLabel(server) + " / " + tn
		if isMeaningful(a.ToolArguments) {
			input = prettyJSON(a.ToolArguments)
		}
		return label, server, input
	}
	label = short
	if isMeaningful(args) {
		input = prettyJSON(args)
	}
	return label, "", input
}

// resultString prefers the structured result object, falling back to the raw
// output string (which is itself often JSON-encoded).
func resultString(output, result json.RawMessage) string {
	if isMeaningful(result) {
		return prettyJSON(result)
	}
	if len(output) > 0 && strings.TrimSpace(string(output)) != "null" {
		var s string
		if json.Unmarshal(output, &s) == nil {
			return prettyMaybeJSON(s)
		}
		return prettyJSON(output)
	}
	return ""
}

// parseToolResultStep folds one agent-tool-result step into a tool chatStep,
// pulling label/input from step.input.function and result from output/result.
func parseToolResultStep(s tmStep) chatStep {
	inputRaw := s.Input
	outputRaw := s.Output
	resultRaw := s.Result
	toolName := s.ToolName
	if len(inputRaw) == 0 && len(s.Value) > 0 {
		var v struct {
			ToolName string          `json:"toolName"`
			Input    json.RawMessage `json:"input"`
			Output   json.RawMessage `json:"output"`
			Result   json.RawMessage `json:"result"`
		}
		if json.Unmarshal(s.Value, &v) == nil {
			inputRaw = v.Input
			outputRaw = v.Output
			resultRaw = v.Result
			toolName = v.ToolName
		}
	}
	var in struct {
		Function string          `json:"function"`
		Args     json.RawMessage `json:"args"`
	}
	_ = json.Unmarshal(inputRaw, &in)
	label, server, input := describeToolCall(in.Function, in.Args)
	if label == "" {
		if toolName != "" {
			label = toolName
		} else {
			label = "Инструмент"
		}
	}
	return chatStep{Kind: "tool", Tool: label, Text: label, Server: server, Input: input, Result: resultString(outputRaw, resultRaw)}
}

// ---- inference parsing ----

// turnBuilder assembles one assistant turn as a chronological ribbon of blocks.
// Actions that happen back to back pile into the same "steps" block; the text
// the agent writes after them closes that group and becomes its own "text"
// block. A turn therefore reads "2 actions -> text -> 11 actions -> text", the
// way Notion shows it, instead of "28 actions -> every paragraph glued into
// one".
type turnBuilder struct {
	blocks  []chatBlock
	steps   []chatStep
	text    strings.Builder
	pending strings.Builder
}

// addStep appends one visible action and closes any text written before it.
func (b *turnBuilder) addStep(s chatStep) {
	b.flushText()
	b.steps = append(b.steps, s)
	if n := len(b.blocks); n > 0 && b.blocks[n-1].Kind == "steps" {
		b.blocks[n-1].Steps = append(b.blocks[n-1].Steps, s)
		return
	}
	b.blocks = append(b.blocks, chatBlock{Kind: "steps", Steps: []chatStep{s}})
}

// addText buffers a piece of answer text. Pieces that arrive back to back stay
// one paragraph run; only an action in between splits them into two blocks.
func (b *turnBuilder) addText(s string) {
	b.pending.WriteString(s)
}

// flushText closes the buffered text run. Blank runs are dropped so trailing
// whitespace neither creates an empty paragraph nor breaks an action group.
func (b *turnBuilder) flushText() {
	s := b.pending.String()
	b.pending.Reset()
	if strings.TrimSpace(s) == "" {
		return
	}
	if b.text.Len() > 0 {
		b.text.WriteString("\n\n")
	}
	b.text.WriteString(s)
	b.blocks = append(b.blocks, chatBlock{Kind: "text", Text: s})
}

// done finalises the turn: the flat text, the flat action list (both kept for
// backwards compatibility) and the ordered ribbon of blocks.
func (b *turnBuilder) done() (string, []chatStep, []chatBlock) {
	b.flushText()
	return b.text.String(), b.steps, b.blocks
}

// foldInferenceParts folds one agent-inference step.value[] into the turn in
// document order: thinking parts become visible thought steps, text parts feed
// the answer. tool_use parts are skipped here on purpose: tool calls are
// surfaced from agent-tool-result records, which also carry the input arguments
// and the result payload.
func foldInferenceParts(raw json.RawMessage, tb *turnBuilder) {
	var parts []struct {
		Type    string `json:"type"`
		Content string `json:"content"`
		Name    string `json:"name"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return
	}
	for _, p := range parts {
		switch p.Type {
		case "thinking":
			if strings.TrimSpace(p.Content) != "" {
				tb.addStep(chatStep{Kind: "thought", Text: p.Content})
			}
		case "text":
			tb.addText(p.Content)
		}
	}
}

// parseUserText extracts the plain text of a "user" step value ([["text"]]).
func parseUserText(raw json.RawMessage) string {
	var v [][]interface{}
	if json.Unmarshal(raw, &v) != nil {
		return ""
	}
	var b strings.Builder
	for _, seg := range v {
		if len(seg) > 0 {
			if s, ok := seg[0].(string); ok {
				b.WriteString(s)
			}
		}
	}
	return b.String()
}

// extractTurn folds a record-map (ordered by created_time) into the latest
// assistant turn: its concatenated text, the title, the visible steps (thoughts
// interleaved with tool calls), the same turn as an ordered ribbon of action
// groups and text paragraphs, the trailing survey (if the agent is asking for
// details) and any pages it created/edited this turn.
func extractTurn(rm recordMapShape) (text, title string, steps []chatStep, blocks []chatBlock, survey *chatSurvey, pages []chatPageRef) {
	var tb turnBuilder
	for _, m := range sortedThreadMessages(rm) {
		switch m.step.Type {
		case "title":
			var s string
			if json.Unmarshal(m.step.Value, &s) == nil && s != "" {
				title = s
			}
		case "agent-inference":
			foldInferenceParts(m.step.Value, &tb)
			if pr := parseEditReferenceMap(m.step.EditReferenceMap); len(pr) > 0 {
				pages = append(pages, pr...)
			}
		case "agent-tool-result":
			tb.addStep(parseToolResultStep(m.step))
		case "survey":
			if sv := parseSurveyStep(m.step); sv != nil {
				survey = sv
			}
		}
	}
	text, steps, blocks = tb.done()
	return text, title, steps, blocks, survey, pages
}

// parseInferenceStream walks the ndjson patch stream. It prefers the final,
// authoritative record-map; if none is present it falls back to concatenating
// the streamed answer-text deltas (thinking deltas are excluded so the answer
// body never contains the model's reasoning). It also surfaces the trailing
// survey + open-page references from the record-map.
func parseInferenceStream(raw []byte) (text, title string, steps []chatStep, blocks []chatBlock, survey *chatSurvey, pages []chatPageRef) {
	var fallback strings.Builder
	var sItems []sMeta
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
		case "patch-start":
			var ps struct {
				Data struct {
					S []json.RawMessage `json:"s"`
				} `json:"data"`
			}
			if json.Unmarshal([]byte(line), &ps) == nil {
				for _, raw := range ps.Data.S {
					sItems = append(sItems, metaFromItem(raw))
				}
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
				if len(c.ThreadMessage) == 0 {
					continue
				}
				t, ti, st, bl, sv, pg := extractTurn(c)
				if t != "" {
					text = t
				}
				if ti != "" {
					title = ti
				}
				if len(st) > 0 {
					steps = st
				}
				if len(bl) > 0 {
					blocks = bl
				}
				if sv != nil {
					survey = sv
				}
				if len(pg) > 0 {
					pages = pg
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
				if op.O == "a" && strings.HasSuffix(op.P, "/s/-") {
					sItems = append(sItems, metaFromItem(op.V))
					var rec struct {
						Type  string `json:"type"`
						Value string `json:"value"`
					}
					if json.Unmarshal(op.V, &rec) == nil && rec.Type == "title" && rec.Value != "" && title == "" {
						title = rec.Value
					}
				} else if op.O == "x" && strings.HasSuffix(op.P, "/content") {
					var s string
					if json.Unmarshal(op.V, &s) != nil {
						continue
					}
					idx, part, ok := parseContentPath(op.P)
					if ok && idx < len(sItems) {
						meta := sItems[idx]
						if part < len(meta.partTypes) {
							if meta.partTypes[part] == "text" {
								fallback.WriteString(s)
							}
							// thinking deltas are intentionally dropped
						} else {
							fallback.WriteString(s)
						}
					} else {
						fallback.WriteString(s)
					}
				}
			}
		}
	}
	if strings.TrimSpace(text) == "" {
		text = strings.TrimSpace(fallback.String())
		// The record map carried actions but no answer text (or no record map
		// arrived at all): close the ribbon with the streamed text so the turn
		// still ends with the answer instead of with an action group.
		if text != "" {
			blocks = append(blocks, chatBlock{Kind: "text", Text: text})
		}
	}
	return text, title, steps, blocks, survey, pages
}
