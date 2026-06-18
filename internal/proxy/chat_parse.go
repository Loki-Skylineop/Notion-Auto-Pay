package proxy

import (
	"encoding/json"
	"sort"
	"strings"
)

// chat_parse.go holds the ndjson / record-map parsing for the chat proxy plus
// the tool-call presentation helpers. Split out of chat.go to keep each file a
// manageable size.

// ---- record-map shapes ----

type tmStep struct {
	Type     string          `json:"type"`
	Value    json.RawMessage `json:"value"`
	ToolName string          `json:"toolName"`
	Input    json.RawMessage `json:"input"`
	Output   json.RawMessage `json:"output"`
	Result   json.RawMessage `json:"result"`
}

type tmInner struct {
	ID          string `json:"id"`
	CreatedTime int64  `json:"created_time"`
	Step        tmStep `json:"step"`
}

type tmRecord struct {
	Value struct {
		Value tmInner `json:"value"`
	} `json:"value"`
}

type recordMapShape struct {
	ThreadMessage map[string]tmRecord `json:"thread_message"`
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
		out = append(out, orderedTM{created: m.Value.Value.CreatedTime, step: m.Value.Value.Step})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].created < out[j].created })
	return out
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

// parseInferenceParts splits one agent-inference step.value[] into visible
// thought steps and the concatenated answer text. tool_use parts are skipped
// here on purpose: tool calls are surfaced from agent-tool-result records,
// which also carry the input arguments and the result payload.
func parseInferenceParts(raw json.RawMessage) (steps []chatStep, text string) {
	var parts []struct {
		Type    string `json:"type"`
		Content string `json:"content"`
		Name    string `json:"name"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return nil, ""
	}
	var b strings.Builder
	for _, p := range parts {
		switch p.Type {
		case "thinking":
			if strings.TrimSpace(p.Content) != "" {
				steps = append(steps, chatStep{Kind: "thought", Text: p.Content})
			}
		case "text":
			b.WriteString(p.Content)
		}
	}
	return steps, b.String()
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
// assistant turn: its concatenated text, the title and the visible steps
// (thoughts interleaved with tool calls).
func extractTurn(rm recordMapShape) (text, title string, steps []chatStep) {
	for _, m := range sortedThreadMessages(rm) {
		switch m.step.Type {
		case "title":
			var s string
			if json.Unmarshal(m.step.Value, &s) == nil && s != "" {
				title = s
			}
		case "agent-inference":
			st, t := parseInferenceParts(m.step.Value)
			steps = append(steps, st...)
			text += t
		case "agent-tool-result":
			steps = append(steps, parseToolResultStep(m.step))
		}
	}
	return text, title, steps
}

// parseInferenceStream walks the ndjson patch stream. It prefers the final,
// authoritative record-map; if none is present it falls back to concatenating
// the streamed answer-text deltas (thinking deltas are excluded so the answer
// body never contains the model's reasoning).
func parseInferenceStream(raw []byte) (text, title string, steps []chatStep) {
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
				t, ti, st := extractTurn(c)
				if t != "" {
					text = t
				}
				if ti != "" {
					title = ti
				}
				if len(st) > 0 {
					steps = st
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
	}
	return text, title, steps
}
