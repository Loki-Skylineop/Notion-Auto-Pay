package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// chat_edit.go adds the two pieces of the private Notion AI chat protocol the
// dashboard chat was missing. Both were reverse-engineered from a HAR capture
// of the real web client:
//
//  1. Editing the last user message. The client sends ONE saveTransactionsFanout
//     transaction tagged "AgentUserStep.saveUserStepChanges" which (a) updates
//     the existing thread_message step value in place and (b) listRemove-s every
//     message that came after it (the old answer + that turn's steps). Then it
//     re-runs runInferenceTranscript with the SAME step id, so the thread is
//     continued instead of appended to.
//
//  2. Attaching files. The client asks for a presigned upload
//     (getUploadFileUrlForAssistantChatTranscriptUpload), POSTs the bytes to S3
//     as multipart/form-data over HTTP/1.1 (policy fields first, "file" last),
//     and then sends a "computer-file" transcript step carrying the returned
//     attachment: URL right before the user's text.

// ---- attachments ----

// chatAttachment is one file already stored in Notion's S3 bucket and ready to
// ride along with the next message.
type chatAttachment struct {
	FileURL     string `json:"file_url"`     // attachment:<fileId>:<object>.<ext>
	FileName    string `json:"file_name"`    // original name, shown in the UI
	ContentType string `json:"content_type"` // text/plain, image/png, ...
	FileSize    int64  `json:"file_size"`
}

// computerFileStep renders one attachment as the transcript step Notion expects
// (see the "computer-file" step in runInferenceTranscript).
func computerFileStep(a chatAttachment) map[string]interface{} {
	ct := a.ContentType
	if i := strings.Index(ct, ";"); i >= 0 {
		ct = strings.TrimSpace(ct[:i])
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	name := strings.TrimSpace(a.FileName)
	if name == "" {
		name = "file"
	}
	return map[string]interface{}{
		"id":          generateUUIDv4(),
		"type":        "computer-file",
		"fileUrl":     a.FileURL,
		"fileName":    name,
		"contentType": ct,
		"metadata": map[string]interface{}{
			"fileSize":         a.FileSize,
			"attachmentSource": "user_upload",
		},
	}
}

// attachmentSteps renders every usable attachment of one request.
func attachmentSteps(list []chatAttachment) []interface{} {
	out := make([]interface{}, 0, len(list))
	for _, a := range list {
		if strings.TrimSpace(a.FileURL) == "" {
			continue
		}
		out = append(out, computerFileStep(a))
	}
	return out
}

// ---- upload ----

// chatUploadMaxBytes caps a single attachment (the composer refuses bigger).
const chatUploadMaxBytes = 25 << 20

func chatUploadTimeout() time.Duration { return 120 * time.Second }

// chatUploadURLResponse is the getUploadFileUrlForAssistantChatTranscriptUpload
// reply: url is the attachment: reference used by the transcript step, while
// signedUploadPostUrl + fields form the presigned S3 POST.
type chatUploadURLResponse struct {
	URL                 string            `json:"url"`
	SignedGetURL        string            `json:"signedGetUrl"`
	SignedUploadPostURL string            `json:"signedUploadPostUrl"`
	Fields              map[string]string `json:"fields"`
	ChatID              string            `json:"chatId"`
}

// orderedUploadFields returns the policy fields in the order the web client
// sends them (from the capture: Content-Type, x-amz-storage-class, tagging,
// bucket, X-Amz-Algorithm, X-Amz-Credential, X-Amz-Date, X-Amz-Security-Token,
// key, Policy, X-Amz-Signature). Go maps are unordered and S3 only insists on
// "file" being the last part, but replaying the captured order keeps our body
// comparable with the browser one. Anything unexpected follows in a stable
// alphabetical order rather than at random.
func orderedUploadFields(fields map[string]string) []string {
	known := []string{
		"Content-Type",
		"x-amz-storage-class",
		"tagging",
		"bucket",
		"X-Amz-Algorithm",
		"X-Amz-Credential",
		"X-Amz-Date",
		"X-Amz-Security-Token",
		"key",
		"Policy",
		"X-Amz-Signature",
	}
	out := make([]string, 0, len(fields))
	seen := make(map[string]bool, len(fields))
	for _, k := range known {
		if _, ok := fields[k]; ok {
			out = append(out, k)
			seen[k] = true
		}
	}
	rest := make([]string, 0, len(fields))
	for k := range fields {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	return append(out, rest...)
}

// createUploadFilePart writes the trailing "file" part. CreateFormFile would
// hardcode application/octet-stream; the capture shows the browser labelling
// the part with the bare media type ("text/plain") while the charset stays on
// the Content-Type policy field, so mirror that.
func createUploadFilePart(mw *multipart.Writer, objectName, contentType string) (io.Writer, error) {
	mediaType := strings.TrimSpace(contentType)
	if i := strings.IndexByte(mediaType, ';'); i >= 0 {
		mediaType = strings.TrimSpace(mediaType[:i])
	}
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf("form-data; name=\"file\"; filename=%q", objectName))
	h.Set("Content-Type", mediaType)
	return mw.CreatePart(h)
}

// postFileToS3 performs the presigned multipart POST. Every policy field must
// be written before the file part, which is what the browser does too, and the
// request has to travel over HTTP/1.1 - see getS3HTTPClient.
func postFileToS3(postURL string, fields map[string]string, objectName, contentType string, data []byte) error {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for _, k := range orderedUploadFields(fields) {
		if err := mw.WriteField(k, fields[k]); err != nil {
			return err
		}
	}
	part, err := createUploadFilePart(mw, objectName, contentType)
	if err != nil {
		return err
	}
	if _, err := part.Write(data); err != nil {
		return err
	}
	if err := mw.Close(); err != nil {
		return err
	}
	req, err := http.NewRequest("POST", postURL, bytes.NewReader(buf.Bytes()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if AppConfig != nil {
		req.Header.Set("User-Agent", AppConfig.Browser.UserAgent)
	}
	resp, err := getS3HTTPClient(chatUploadTimeout()).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("s3 %d: %s", resp.StatusCode, clip(strings.TrimSpace(string(raw)), 300))
	}
	return nil
}

// uploadChatAttachment runs the full two-hop upload: ask Notion for a presigned
// POST bound to this chat thread, then push the bytes to S3.
func uploadChatAttachment(tokenV2, userID, spaceID, threadID, fileName, contentType string, data []byte) (*chatAttachment, error) {
	fileName = strings.TrimSpace(filepath.Base(fileName))
	if fileName == "" || fileName == "." || fileName == string(filepath.Separator) {
		fileName = "file"
	}
	ext := strings.ToLower(filepath.Ext(fileName))
	contentType = strings.TrimSpace(contentType)
	if contentType == "" && ext != "" {
		contentType = mime.TypeByExtension(ext)
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if ext == "" {
		if exts, _ := mime.ExtensionsByType(contentType); len(exts) > 0 {
			ext = exts[0]
		}
	}
	// Notion stores the object under a random name; the human-readable name
	// only lives on the transcript step, exactly like the web client.
	objectName := generateUUIDv4() + ext

	reqBody, _ := json.Marshal(map[string]interface{}{
		"name":                  objectName,
		"contentType":           contentType,
		"contentLength":         len(data),
		"createThread":          true,
		"allowUnsupportedTypes": true,
		"assistantChatTranscriptSessionPointer": map[string]string{
			"spaceId": spaceID,
			"table":   "thread",
			"id":      threadID,
		},
	})
	resp, err := notionChatRequest(tokenV2, userID, spaceID, "getUploadFileUrlForAssistantChatTranscriptUpload", reqBody, "application/json", chatAPITimeout())
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("notion %d: %s", resp.StatusCode, clip(strings.TrimSpace(string(raw)), 300))
	}
	var up chatUploadURLResponse
	if err := json.Unmarshal(raw, &up); err != nil {
		return nil, err
	}
	if up.SignedUploadPostURL == "" || up.URL == "" {
		return nil, fmt.Errorf("Notion не выдал ссылку для загрузки файла")
	}
	if err := postFileToS3(up.SignedUploadPostURL, up.Fields, objectName, contentType, data); err != nil {
		return nil, err
	}
	return &chatAttachment{
		FileURL:     up.URL,
		FileName:    fileName,
		ContentType: contentType,
		FileSize:    int64(len(data)),
	}, nil
}

// HandleChatUpload accepts one file from the composer (multipart/form-data),
// pushes it to Notion's bucket and returns the attachment descriptor the next
// send/edit request has to echo back.
func HandleChatUpload(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !chatAuthOK(auth, w, r) {
			return
		}
		if err := r.ParseMultipartForm(chatUploadMaxBytes); err != nil {
			http.Error(w, `{"error":"invalid multipart form"}`, http.StatusBadRequest)
			return
		}
		tokenV2 := strings.TrimSpace(r.FormValue("token_v2"))
		userID := strings.TrimSpace(r.FormValue("user_id"))
		spaceID := strings.TrimSpace(r.FormValue("space_id"))
		threadID := strings.TrimSpace(r.FormValue("thread_id"))
		if tokenV2 == "" || spaceID == "" {
			http.Error(w, `{"error":"token_v2 and space_id are required"}`, http.StatusBadRequest)
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			http.Error(w, `{"error":"file is required"}`, http.StatusBadRequest)
			return
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, chatUploadMaxBytes+1))
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		if len(data) > chatUploadMaxBytes {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			json.NewEncoder(w).Encode(map[string]string{"error": "файл больше 25 МБ"})
			return
		}
		// A file can be attached before the first message of a brand-new chat, so
		// mint the thread id here and hand it back: the send request reuses it as
		// pending_thread_id, which is what the web client does as well.
		if threadID == "" {
			threadID = generateUUIDv4()
		}
		att, err := uploadChatAttachment(tokenV2, userID, spaceID, threadID, header.Filename, header.Header.Get("Content-Type"), data)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":         true,
			"thread_id":  threadID,
			"attachment": att,
		})
	}
}

// ---- edit last message ----

// chatEditBody mirrors chatSendBody plus the (optional) id of the message being
// edited. When message_id is empty the server resolves the thread's last user
// message itself, so the browser never has to track Notion's step ids.
type chatEditBody struct {
	TokenV2         string           `json:"token_v2"`
	UserID          string           `json:"user_id"`
	UserName        string           `json:"user_name"`
	UserEmail       string           `json:"user_email"`
	SpaceID         string           `json:"space_id"`
	SpaceViewID     string           `json:"space_view_id"`
	SpaceName       string           `json:"space_name"`
	Timezone        string           `json:"timezone"`
	Agent           string           `json:"agent"`
	Model           string           `json:"model"`
	ReasoningEffort string           `json:"reasoning_effort"`
	ThreadID        string           `json:"thread_id"`
	MessageID       string           `json:"message_id"`
	Message         string           `json:"message"`
	Attachments     []chatAttachment `json:"attachments"`
}

// resolveLastUserMessage returns the id of the thread's last "user" step and
// every message id that follows it (the answer that has to be dropped).
func resolveLastUserMessage(tokenV2, userID, spaceID, threadID string) (string, []string, error) {
	threadData, err := syncRecordValues(tokenV2, userID, spaceID, []map[string]string{
		{"table": "thread", "id": threadID, "spaceId": spaceID},
	})
	if err != nil {
		return "", nil, err
	}
	var tr struct {
		RecordMap struct {
			Thread map[string]threadRecordShape `json:"thread"`
		} `json:"recordMap"`
	}
	if err := json.Unmarshal(threadData, &tr); err != nil {
		return "", nil, err
	}
	var order []string
	if t, ok := tr.RecordMap.Thread[threadID]; ok {
		order = t.Value.Value.Messages
	}
	if len(order) == 0 {
		return "", nil, fmt.Errorf("в этом чате пока нет сообщений")
	}
	pointers := make([]map[string]string, 0, len(order))
	for _, id := range order {
		pointers = append(pointers, map[string]string{"table": "thread_message", "id": id, "spaceId": spaceID})
	}
	msgData, err := syncRecordValues(tokenV2, userID, spaceID, pointers)
	if err != nil {
		return "", nil, err
	}
	var wrap struct {
		RecordMap recordMapShape `json:"recordMap"`
	}
	if err := json.Unmarshal(msgData, &wrap); err != nil {
		return "", nil, err
	}
	idx := -1
	for i, id := range order {
		rec, ok := wrap.RecordMap.ThreadMessage[id]
		if !ok {
			continue
		}
		if rec.Value.Value.Step.Type == "user" {
			idx = i
		}
	}
	if idx < 0 {
		return "", nil, fmt.Errorf("в этом чате нет сообщения пользователя")
	}
	trailing := append([]string{}, order[idx+1:]...)
	return order[idx], trailing, nil
}

// HandleChatEdit rewrites the last user message and re-runs the agent. It
// streams the new answer exactly like HandleChatStream, so the browser can
// reuse the same ndjson reader.
func HandleChatEdit(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !chatAuthOK(auth, w, r) {
			return
		}
		var body chatEditBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		body.TokenV2 = strings.TrimSpace(body.TokenV2)
		body.SpaceID = strings.TrimSpace(body.SpaceID)
		body.ThreadID = strings.TrimSpace(body.ThreadID)
		body.MessageID = strings.TrimSpace(body.MessageID)
		body.Message = strings.TrimSpace(body.Message)
		if body.TokenV2 == "" || body.SpaceID == "" || body.ThreadID == "" || body.Message == "" {
			http.Error(w, `{"error":"token_v2, space_id, thread_id and message are required"}`, http.StatusBadRequest)
			return
		}

		writeStreamErr := func(msg string) {
			// Раньше сбой правки уходил в никуда: в UI пустота, в логе
			// ничего. Теперь каждая причина видна в консоли сервера.
			log.Printf("[chat] edit failed (thread %s): %s", body.ThreadID, msg)
			w.Header().Set("Content-Type", "application/x-ndjson")
			b, _ := json.Marshal(map[string]interface{}{"event": "error", "error": msg})
			w.Write(b)
			w.Write([]byte("\n"))
		}

		msgID := body.MessageID
		var trailing []string
		resolvedID, resolvedTrailing, err := resolveLastUserMessage(body.TokenV2, body.UserID, body.SpaceID, body.ThreadID)
		if err != nil {
			if msgID == "" {
				writeStreamErr(fmt.Sprintf("не нашёл сообщение для правки: %v", err))
				return
			}
			log.Printf("[chat] edit: resolve failed, falling back to client message_id %s: %v", msgID, err)
		} else if msgID == "" || msgID == resolvedID {
			msgID = resolvedID
			trailing = resolvedTrailing
		}
		if msgID == "" {
			writeStreamErr("не удалось найти сообщение для правки")
			return
		}
		log.Printf("[chat] edit thread %s: step %s, dropping %d step(s) after it", body.ThreadID, msgID, len(trailing))

		// Re-running costs credits just like a normal turn.
		defer armOverageForTurn(body.TokenV2, body.UserID, body.SpaceID)()

		// One transaction: rewrite the step in place, then drop everything that
		// came after it ("AgentUserStep.saveUserStepChanges").
		ops := []interface{}{
			map[string]interface{}{
				"pointer": map[string]string{"table": "thread_message", "id": msgID, "spaceId": body.SpaceID},
				"path":    []string{"step"},
				"command": "update",
				"args":    map[string]interface{}{"value": [][]string{{body.Message}}},
			},
		}
		for _, id := range trailing {
			ops = append(ops, map[string]interface{}{
				"pointer": map[string]string{"table": "thread", "id": body.ThreadID, "spaceId": body.SpaceID},
				"path":    []string{"messages"},
				"command": "listRemove",
				"args":    map[string]string{"id": id},
			})
		}
		tx := map[string]interface{}{
			"id":      generateUUIDv4(),
			"spaceId": body.SpaceID,
			"debug": map[string]interface{}{
				"userAction":         "AgentUserStep.saveUserStepChanges",
				"clientCommitTimeMs": time.Now().UnixMilli(),
			},
			"operations": ops,
		}
		saveBody, _ := json.Marshal(map[string]interface{}{
			"requestId":    generateUUIDv4(),
			"transactions": []interface{}{tx},
		})
		saveResp, err := notionChatRequest(body.TokenV2, body.UserID, body.SpaceID, "saveTransactionsFanout", saveBody, "application/json", chatAPITimeout())
		if err != nil {
			writeStreamErr(fmt.Sprintf("правка не сохранилась: %v", err))
			return
		}
		saveRaw, _ := io.ReadAll(saveResp.Body)
		saveResp.Body.Close()
		if saveResp.StatusCode != 200 {
			// Тело ответа Notion раньше выбрасывалось, и наверх шло голое
			// "notion 400" без причины — диагностировать было нечем.
			writeStreamErr(fmt.Sprintf("правка не сохранилась: notion %d: %s", saveResp.StatusCode, truncate(string(saveRaw), 300)))
			return
		}

		// Re-run with the edited step. Same transcript shape as a normal turn,
		// but the user step keeps the id of the message we just rewrote and the
		// title is left alone.
		payload, threadID := buildSendPayload(chatSendBody{
			TokenV2:         body.TokenV2,
			UserID:          body.UserID,
			UserName:        body.UserName,
			UserEmail:       body.UserEmail,
			SpaceID:         body.SpaceID,
			SpaceViewID:     body.SpaceViewID,
			SpaceName:       body.SpaceName,
			Timezone:        body.Timezone,
			Agent:           body.Agent,
			Model:           body.Model,
			ReasoningEffort: body.ReasoningEffort,
			ThreadID:        body.ThreadID,
			Message:         body.Message,
			Attachments:     body.Attachments,
		})
		if steps, ok := payload["transcript"].([]interface{}); ok && len(steps) > 0 {
			if last, ok := steps[len(steps)-1].(map[string]interface{}); ok {
				last["id"] = msgID
			}
		}
		payload["generateTitle"] = false
		payload["debugOverrides"] = map[string]interface{}{
			"emitAgentSearchExtractedResults": true,
			"cachedInferences":                map[string]interface{}{},
			"annotationInferences":            map[string]interface{}{},
			"emitInferences":                  false,
		}
		streamInference(w, body.TokenV2, body.UserID, body.SpaceID, threadID, payload)
	}
}
