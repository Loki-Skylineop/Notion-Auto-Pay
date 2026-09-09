package proxy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func installAPIConfigTestState(t *testing.T) *Config {
	t.Helper()
	originalConfig := AppConfig
	originalModels := SnapshotModelMap()
	originalMode, originalEmail := APIRouting()
	originalSpace, originalSpaceName, originalSpaceView := APIRoutingSpace()

	cfg := DefaultConfig()
	cfg.Server.ApiKey = "sk-old-test-key"
	cfg.Proxy.DefaultModel = "opus-4.6"
	AppConfig = cfg
	SetAPIRouting(APIRoutingAuto, "", "", "", "")
	ReplaceModelMap(map[string]string{
		"opus-4.6":   "avocado-froyo-medium",
		"sonnet-4.6": "avocado-froyo-large",
	})

	t.Cleanup(func() {
		AppConfig = originalConfig
		ReplaceModelMap(originalModels)
		SetAPIRouting(originalMode, originalEmail, originalSpace, originalSpaceName, originalSpaceView)
	})
	return cfg
}

func TestHandleAdminAPIConfig_GetAndRotate(t *testing.T) {
	installAPIConfigTestState(t)
	handler := HandleAdminAPIConfig(NewAccountPool(), "", nil)

	getRecorder := httptest.NewRecorder()
	handler.ServeHTTP(getRecorder, httptest.NewRequest(http.MethodGet, "/admin/api/config", nil))
	if getRecorder.Code != http.StatusOK {
		t.Fatalf("GET status = %d, body=%s", getRecorder.Code, getRecorder.Body.String())
	}
	var initial map[string]interface{}
	if err := json.Unmarshal(getRecorder.Body.Bytes(), &initial); err != nil {
		t.Fatal(err)
	}
	if initial["model_alias"] != AIRIModelAlias {
		t.Fatalf("model_alias = %v", initial["model_alias"])
	}
	if initial["api_key"] != "sk-old-test-key" {
		t.Fatalf("unexpected API key in payload")
	}

	body := bytes.NewBufferString(`{"rotate_key":true,"default_model":"sonnet-4.6","api_routing":"auto"}`)
	putRecorder := httptest.NewRecorder()
	handler.ServeHTTP(putRecorder, httptest.NewRequest(http.MethodPut, "/admin/api/config", body))
	if putRecorder.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body=%s", putRecorder.Code, putRecorder.Body.String())
	}
	if got := CurrentAPIKey(); got == "" || got == "sk-old-test-key" {
		t.Fatalf("key was not rotated: %q", got)
	}
	if got := APIDefaultModel(); got != "sonnet-4.6" {
		t.Fatalf("default model = %q", got)
	}
}

func TestHandleAdminAPIConfig_ValidatesBeforeRotation(t *testing.T) {
	installAPIConfigTestState(t)
	handler := HandleAdminAPIConfig(NewAccountPool(), "", nil)
	body := bytes.NewBufferString(`{"rotate_key":true,"api_routing":"pinned","api_account":"","api_space":""}`)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPut, "/admin/api/config", body))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if got := CurrentAPIKey(); got != "sk-old-test-key" {
		t.Fatalf("invalid update rotated the key: %q", got)
	}
}

func TestResolveAPIModelAlias(t *testing.T) {
	installAPIConfigTestState(t)
	if got := resolveAPIModel("notion-ai"); got != "opus-4.6" {
		t.Fatalf("alias resolved to %q", got)
	}
	if got := resolveAPIModel("sonnet-4.6"); got != "sonnet-4.6" {
		t.Fatalf("explicit model resolved to %q", got)
	}
}

func TestExtractAnthropicSessionSaltFromRequest(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	req.Header.Set("x-airi-session-id", "airi-session")
	if got := extractAnthropicSessionSaltFromRequest(req, map[string]interface{}{"session_id": "metadata-session"}); got != "airi-session" {
		t.Fatalf("header was not preferred: %q", got)
	}

	fallback := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	if got := extractAnthropicSessionSaltFromRequest(fallback, map[string]interface{}{"conversation_id": "metadata-session"}); got != "metadata-session" {
		t.Fatalf("metadata fallback = %q", got)
	}
}
