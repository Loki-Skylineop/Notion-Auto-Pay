package proxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

func mcpFilterToolsJSON(b []byte, mode string) []byte {
	var message map[string]json.RawMessage
	if json.Unmarshal(b, &message) != nil {
		return b
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(message["result"], &result) != nil {
		return b
	}
	raw, ok := result["tools"]
	if !ok {
		return b
	}
	var tools []map[string]json.RawMessage
	if json.Unmarshal(raw, &tools) != nil {
		return b
	}
	filtered := []map[string]json.RawMessage{}
	for _, tool := range tools {
		var name string
		_ = json.Unmarshal(tool["name"], &name)
		if mcpAllowed(mode, name) {
			filtered = append(filtered, tool)
		}
	}
	result["tools"], _ = json.Marshal(filtered)
	message["result"], _ = json.Marshal(result)
	out, e := json.Marshal(message)
	if e != nil {
		return b
	}
	return out
}
func mcpFilterToolsResponse(resp *http.Response, mode string) error {
	if resp.StatusCode != 200 {
		return nil
	}
	ct := resp.Header.Get("Content-Type")
	if strings.Contains(ct, "application/json") {
		b, e := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		if e != nil {
			return e
		}
		b = mcpFilterToolsJSON(b, mode)
		resp.Body = io.NopCloser(bytes.NewReader(b))
		resp.ContentLength = int64(len(b))
		resp.Header.Del("Content-Length")
		return nil
	}
	if strings.Contains(ct, "text/event-stream") {
		original := resp.Body
		r, w := io.Pipe()
		resp.Body = r
		resp.ContentLength = -1
		resp.Header.Del("Content-Length")
		go func() {
			defer original.Close()
			defer w.Close()
			scanner := bufio.NewScanner(original)
			scanner.Buffer(make([]byte, 4096), 8<<20)
			for scanner.Scan() {
				line := scanner.Text()
				if strings.HasPrefix(line, "data:") {
					data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
					line = "data: " + string(mcpFilterToolsJSON([]byte(data), mode))
				}
				if _, e := io.WriteString(w, line+"\n"); e != nil {
					return
				}
			}
			if e := scanner.Err(); e != nil {
				w.CloseWithError(e)
			}
		}()
	}
	return nil
}
