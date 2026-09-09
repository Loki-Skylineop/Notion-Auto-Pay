package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"notion-manager/internal/proxy"
)

func TestRequiresAPIKey(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{path: "/v1/messages", want: true},
		{path: "/v1/airi/chat/completions", want: true},
		{path: "/v1/airi/models", want: true},
		{path: "/v1/models", want: true},
		{path: "/models", want: true},
		{path: "/health", want: false},
		{path: "/dashboard/", want: false},
	}

	for _, tc := range tests {
		if got := requiresAPIKey(tc.path); got != tc.want {
			t.Fatalf("requiresAPIKey(%q) = %v, want %v", tc.path, got, tc.want)
		}
	}
}

func TestAPIKeyAuthMiddleware_ProtectsModelsRoutes(t *testing.T) {
	handler := apiKeyAuthMiddleware("sk-test", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	tests := []struct {
		name    string
		path    string
		headers map[string]string
		want    int
	}{
		{name: "models missing key", path: "/models", want: http.StatusUnauthorized},
		{name: "models wrong key", path: "/models", headers: map[string]string{"Authorization": "Bearer sk-wrong"}, want: http.StatusUnauthorized},
		{name: "models bearer", path: "/models", headers: map[string]string{"Authorization": "Bearer sk-test"}, want: http.StatusNoContent},
		{name: "v1 models x-api-key", path: "/v1/models", headers: map[string]string{"x-api-key": "sk-test"}, want: http.StatusNoContent},
		{name: "messages missing key", path: "/v1/messages", want: http.StatusUnauthorized},
		{name: "AIRI chat missing key", path: "/v1/airi/chat/completions", want: http.StatusUnauthorized},
		{name: "health no auth", path: "/health", want: http.StatusNoContent},
	}

	for _, tc := range tests {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, tc.path, nil)
		for key, value := range tc.headers {
			req.Header.Set(key, value)
		}

		handler.ServeHTTP(rec, req)

		if rec.Code != tc.want {
			t.Fatalf("%s: expected %d, got %d body=%s", tc.name, tc.want, rec.Code, rec.Body.String())
		}
	}
}

func TestNewMux_RegistersModelsRoutes(t *testing.T) {
	original := proxy.SnapshotModelMap()
	proxy.ReplaceModelMap(map[string]string{
		"opus-4.6": "avocado-froyo-medium",
	})
	t.Cleanup(func() {
		proxy.ReplaceModelMap(original)
	})

	originalConfig := proxy.AppConfig
	proxy.AppConfig = proxy.DefaultConfig()
	t.Cleanup(func() {
		proxy.AppConfig = originalConfig
	})

	pool := proxy.NewAccountPool()
	dashAuth := proxy.NewDashboardAuth("", "sk-test")
	usageStats := proxy.InitUsageStats("")
	regDeps := &proxy.RegisterJobsDeps{Pool: pool, AccountsDir: "", Auth: dashAuth}
	autoPay := proxy.NewAutoPayManager(pool, "", "")
	mux := newMux(pool, "", "sk-test", dashAuth, usageStats, regDeps, autoPay)
	handler := apiKeyAuthMiddleware("sk-test", mux)

	for _, path := range []string{"/v1/models", "/v1/airi/models", "/models"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer sk-test")
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("%s: expected 200, got %d body=%s", path, rec.Code, rec.Body.String())
		}
	}
}

func TestAPIKeyAuthMiddleware_UsesRotatedRuntimeKey(t *testing.T) {
	originalConfig := proxy.AppConfig
	proxy.AppConfig = proxy.DefaultConfig()
	proxy.AppConfig.Server.ApiKey = "sk-old"
	t.Cleanup(func() { proxy.AppConfig = originalConfig })

	handler := apiKeyAuthMiddleware("sk-old", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	request := func(key string) int {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
		req.Header.Set("Authorization", "Bearer "+key)
		handler.ServeHTTP(recorder, req)
		return recorder.Code
	}

	if got := request("sk-old"); got != http.StatusNoContent {
		t.Fatalf("initial key status = %d", got)
	}
	proxy.AppConfig.Server.ApiKey = "sk-new"
	if got := request("sk-old"); got != http.StatusUnauthorized {
		t.Fatalf("old key after rotation status = %d", got)
	}
	if got := request("sk-new"); got != http.StatusNoContent {
		t.Fatalf("new key after rotation status = %d", got)
	}
}

func TestNewMux_RegistersAIRIChatRoute(t *testing.T) {
	originalConfig := proxy.AppConfig
	proxy.AppConfig = proxy.DefaultConfig()
	proxy.AppConfig.Server.ApiKey = "sk-test"
	t.Cleanup(func() { proxy.AppConfig = originalConfig })

	pool := proxy.NewAccountPool()
	dashAuth := proxy.NewDashboardAuth("", "sk-test")
	usageStats := proxy.InitUsageStats("")
	regDeps := &proxy.RegisterJobsDeps{Pool: pool, AccountsDir: "", Auth: dashAuth}
	autoPay := proxy.NewAutoPayManager(pool, "", "")
	handler := apiKeyAuthMiddleware("sk-test", newMux(pool, "", "sk-test", dashAuth, usageStats, regDeps, autoPay))

	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/airi/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer sk-test")
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("AIRI route status = %d, want 405; body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestCORSMiddleware_AllowsAIRIHeaders(t *testing.T) {
	handler := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/v1/airi/chat/completions", nil)
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("preflight status = %d", recorder.Code)
	}
	allowed := strings.ToLower(recorder.Header().Get("Access-Control-Allow-Headers"))
	for _, header := range []string{
		"anthropic-dangerous-direct-browser-access",
		"x-airi-session-id",
		"x-airi-round-id",
		"x-airi-app-surface",
	} {
		if !strings.Contains(allowed, header) {
			t.Fatalf("CORS allow headers missing %q: %s", header, allowed)
		}
	}
}
