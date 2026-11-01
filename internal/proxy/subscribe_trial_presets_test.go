package proxy

import (
	"encoding/json"
	"testing"
)

func TestTrialMethodNormalization(t *testing.T) {
	for _, method := range []string{"", "sidebar", "script33", "script33_v2"} {
		got, err := normalizeTrialMethod(" " + method + " ")
		want := method
		if want == "" {
			want = trialMethodSidebar
		}
		if err != nil || got != want {
			t.Fatalf("normalize(%q) = %q, %v; want %q", method, got, err, want)
		}
	}
	if _, err := normalizeTrialMethod("unrecognized"); err == nil {
		t.Fatal("unknown method was accepted")
	}
}

func TestTrialPaymentValidation(t *testing.T) {
	cases := []struct {
		name, method, paymentID, country string
		confirmed, valid                 bool
	}{
		{"legacy", "sidebar", "", "", false, true},
		{"legacy cannot charge", "sidebar", "pm_own123", "DE", true, false},
		{"first script", "script33", "pm_own123", "DE", true, true},
		{"second script", "script33_v2", "pm_own456", "US", true, true},
		{"missing method", "script33", "", "DE", true, false},
		{"invalid method", "script33", "card_123", "DE", true, false},
		{"invalid characters", "script33", "pm_own/123", "DE", true, false},
		{"missing country", "script33", "pm_own123", "", true, false},
		{"invalid country", "script33", "pm_own123", "Germany", true, false},
		{"missing consent", "script33", "pm_own123", "DE", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateTrialPayment(tc.method, tc.paymentID, tc.country, tc.confirmed)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v, error=%v", tc.valid, err)
			}
		})
	}
}

func TestTrialWorkspaceSelection(t *testing.T) {
	body := []byte(`{"owner":{"space":{
		"free-old":{"value":{"value":{"subscription_tier":"free","created_time":10}}},
		"free-new":{"value":{"subscription_tier":"free","created_time":20}},
		"paid-new":{"value":{"value":{"subscription_tier":"business","created_time":30}}},
		"deleted":{"value":{"value":{"subscription_tier":"free","created_time":99,"alive":false}}}
	}},"other":{"space":{"foreign":{"value":{"subscription_tier":"free","created_time":100}}}}}`)
	cases := []struct {
		name, user, method, requested, want string
		valid                               bool
	}{
		{"newest free", "owner", "script33", "", "free-new", true},
		{"v2 refuses newest paid", "owner", "script33_v2", "", "", false},
		{"explicit wins first", "owner", "script33", "free-old", "free-old", true},
		{"explicit wins second", "owner", "script33_v2", "free-old", "free-old", true},
		{"missing explicit never substituted", "owner", "script33", "missing", "", false},
		{"paid explicit refused", "owner", "script33", "paid-new", "", false},
		{"deleted explicit refused", "owner", "script33", "deleted", "", false},
		{"different user never used", "missing-user", "script33", "", "", false},
		{"foreign space never used", "owner", "script33", "foreign", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := selectScriptTrialSpace(body, tc.user, tc.method, tc.requested)
			if (err == nil) != tc.valid || got != tc.want {
				t.Fatalf("got=%q error=%v; want=%q valid=%v", got, err, tc.want, tc.valid)
			}
		})
	}
	if _, err := selectScriptTrialSpace([]byte(`not JSON`), "owner", "script33", ""); err == nil {
		t.Fatal("malformed discovery response was accepted")
	}
	freeOnly := []byte(`{"owner":{"space":{"a":{"value":{"subscription_tier":"free","created_time":10}},"b":{"value":{"subscription_tier":"free","created_time":20}}}}}`)
	if got, err := selectScriptTrialSpace(freeOnly, "owner", "script33_v2", ""); err != nil || got != "b" {
		t.Fatalf("v2 newest Free = %q, %v", got, err)
	}
}

func TestTrialPayloadPresets(t *testing.T) {
	for _, method := range []string{"sidebar", "script33", "script33_v2"} {
		t.Run(method, func(t *testing.T) {
			req := trialRequest{
				Method: method, SpaceID: "selected-space", Plan: defaultTrialPlan,
				TrialID: defaultTrialID, From: defaultTrialFrom,
				TrialEnd: "2026-11-15T12:00:00.000+00:00", ClientVersion: "test-version",
				PaymentID: "pm_ownPayment123", Country: "US", BillingEmail: "owner@example.test",
				CustomerName: "Owner", CaptchaToken: "user-provided-captcha",
			}
			encoded, err := json.Marshal(buildNotionTrialPayload(req))
			if err != nil {
				t.Fatal(err)
			}
			var payload map[string]interface{}
			if err := json.Unmarshal(encoded, &payload); err != nil {
				t.Fatal(err)
			}
			if payload["spaceId"] != "selected-space" || payload["captchaToken"] != "user-provided-captcha" {
				t.Fatalf("target/captcha changed: %s", encoded)
			}
			state := payload["desiredState"].(map[string]interface{})
			if state["trialEnd"] != req.TrialEnd {
				t.Fatal("trial end changed")
			}
			trial := payload["trialData"].(map[string]interface{})
			if method == "sidebar" {
				for _, key := range []string{"paymentMethodId", "billingEmail", "addressCountry"} {
					if _, ok := payload[key]; ok {
						t.Fatalf("card-free payload contains %s", key)
					}
				}
				if trial["autoConvert"] != false || trial["id"] != defaultTrialID {
					t.Fatalf("legacy offer changed: %s", encoded)
				}
				return
			}
			if payload["paymentMethodId"] != req.PaymentID || payload["addressCountry"] != "US" || payload["billingEmail"] != req.BillingEmail {
				t.Fatalf("customer-supplied billing information changed: %s", encoded)
			}
			if trial["id"] != scriptTrialID || trial["from"] != scriptTrialFrom || payload["from"] != scriptTrialFrom {
				t.Fatalf("wrong script trial offer: %s", encoded)
			}
			if _, ok := trial["autoConvert"]; ok {
				t.Fatal("script offers must not claim that renewal is disabled")
			}
			price := state["items"].([]interface{})[0].(map[string]interface{})["price"].(map[string]interface{})
			amount := price["unitAmount"].(map[string]interface{})
			if price["externalId"] != scriptTrialPlan || price["product"] != "business" || price["billingInterval"] != "month" || amount["currencyCode"] != "USD" || amount["amount"] != float64(2400) {
				t.Fatalf("wrong fixed script plan: %s", encoded)
			}
		})
	}
}

func TestTrialSuccessRequiresConfirmation(t *testing.T) {
	for _, body := range []string{"", "null", "{}", `{"subscriptionStatus":"active"}`, `{"subscriptionStatus":"past_due"}`, `{"error":"denied"}`} {
		if _, err := parseNotionTrialResult([]byte(body)); err == nil {
			t.Fatalf("unconfirmed trial accepted: %s", body)
		}
	}
	out, err := parseNotionTrialResult([]byte(`{"subscriptionStatus":"trialing","invoiceUrl":"test-invoice"}`))
	if err != nil || out.SubscriptionStatus != "trialing" || out.InvoiceURL != "test-invoice" {
		t.Fatalf("confirmed trial rejected: %+v, %v", out, err)
	}
}
