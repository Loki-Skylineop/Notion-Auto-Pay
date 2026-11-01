package proxy

import (
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"strings"
)

var trialDefaultsPaymentPattern = regexp.MustCompile(`^pm_[A-Za-z0-9]{1,128}$`)
var trialDefaultsCountryPattern = regexp.MustCompile(`^[A-Z]{2}$`)

type trialDefaultsResponse struct {
	PaymentID string `json:"payment_method_id,omitempty"`
	Country   string `json:"country,omitempty"`
}

// HandleTrialDefaults keeps personal payment references out of public source
// and static bundles. Only the configured, logged-in owner receives a preset.
// An open/auth-disabled dashboard never receives private defaults.
func HandleTrialDefaults(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store, private")
		w.Header().Set("Vary", "Cookie")
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		caller := auth.CallerFor(r)
		if !caller.LoggedIn || caller.AuthOff {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		result := trialDefaultsResponse{}
		owner := NormalizeUsername(strings.TrimSpace(os.Getenv("NOTION_TRIAL_DEFAULTS_OWNER")))
		if owner != "" && caller.Username == owner {
			paymentID := strings.TrimSpace(os.Getenv("NOTION_TRIAL_PAYMENT_METHOD_ID"))
			country := strings.ToUpper(strings.TrimSpace(os.Getenv("NOTION_TRIAL_BILLING_COUNTRY")))
			if trialDefaultsPaymentPattern.MatchString(paymentID) && trialDefaultsCountryPattern.MatchString(country) {
				result.PaymentID, result.Country = paymentID, country
			}
		}
		_ = json.NewEncoder(w).Encode(result)
	}
}
