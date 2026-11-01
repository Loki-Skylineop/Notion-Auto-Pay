package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTrialDefaultsPrivate(t *testing.T) {
	t.Setenv("NOTION_TRIAL_DEFAULTS_OWNER", "admin")
	t.Setenv("NOTION_TRIAL_PAYMENT_METHOD_ID", "pm_testOnly0001")
	t.Setenv("NOTION_TRIAL_BILLING_COUNTRY", "ke")
	auth := &DashboardAuth{adminPasswordHash: "configured-for-test"}
	session := httptest.NewRecorder()
	auth.createSessionFor(session, "admin", RoleAdmin)
	cookie := session.Result().Cookies()[0]
	request := func(method string, signedIn bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/admin/subscribe/trial-defaults", nil)
		if signedIn {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		HandleTrialDefaults(auth)(w, r)
		if !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
			t.Fatal("private defaults must not be cached")
		}
		return w
	}
	if w := request(http.MethodGet, false); w.Code != http.StatusUnauthorized || strings.Contains(w.Body.String(), "pm_test") {
		t.Fatal("anonymous request received private defaults")
	}
	if w := request(http.MethodPost, true); w.Code != http.StatusMethodNotAllowed {
		t.Fatal("only GET is allowed")
	}
	w := request(http.MethodGet, true)
	var got trialDefaultsResponse
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &got) != nil || got.PaymentID != "pm_testOnly0001" || got.Country != "KE" {
		t.Fatal("owner did not receive validated defaults")
	}
	for _, tc := range []struct{ name, variable, value string }{
		{"different owner", "NOTION_TRIAL_DEFAULTS_OWNER", "another-owner"},
		{"no owner", "NOTION_TRIAL_DEFAULTS_OWNER", ""},
		{"invalid payment", "NOTION_TRIAL_PAYMENT_METHOD_ID", "not-a-payment-id"},
		{"invalid country", "NOTION_TRIAL_BILLING_COUNTRY", "123"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(tc.variable, tc.value)
			w := request(http.MethodGet, true)
			if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != "{}" {
				t.Fatal("unavailable defaults were not isolated")
			}
		})
	}
	for _, a := range []*DashboardAuth{nil, {}} {
		w := httptest.NewRecorder()
		HandleTrialDefaults(a)(w, httptest.NewRequest(http.MethodGet, "/admin/subscribe/trial-defaults", nil))
		if w.Code != http.StatusUnauthorized || strings.Contains(w.Body.String(), "pm_test") {
			t.Fatal("auth-disabled dashboard received defaults")
		}
	}
}
