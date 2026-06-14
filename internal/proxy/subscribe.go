package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
)

// HandleSubscribe creates or upgrades a Notion subscription via Stripe.
// It accepts a token_v2, discovers the account, creates a Stripe PaymentMethod,
// and calls Notion's updateSubscription API.
//
// POST /admin/subscribe
// Body: { "token_v2": "...", "card_token": "...", "plan": "enterprise_monthly_eur_202505" }
func HandleSubscribe(accountsDir string, auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if r.Method != "POST" {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}

		if auth.HasAdminPassword() && !auth.ValidateSession(r) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}

		var body struct {
			TokenV2     string `json:"token_v2"`
			CardToken   string `json:"card_token"`   // Stripe payment method ID (pm_...)
			Plan        string `json:"plan"`          // e.g. "enterprise_monthly_eur_202505"
			SpaceID     string `json:"space_id"`      // optional, discovered from token
			Email       string `json:"email"`         // optional, for billing
			Country     string `json:"country"`       // billing country code (DE, US, etc.)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		tokenV2 := strings.TrimSpace(body.TokenV2)
		cardToken := strings.TrimSpace(body.CardToken)
		plan := strings.TrimSpace(body.Plan)

		if tokenV2 == "" {
			http.Error(w, `{"error":"token_v2 is required"}`, http.StatusBadRequest)
			return
		}
		if cardToken == "" {
			http.Error(w, `{"error":"card_token (Stripe payment method ID) is required"}`, http.StatusBadRequest)
			return
		}
		if plan == "" {
			plan = "enterprise_monthly_eur_202505"
		}

		// Step 1: Discover account from token
		log.Printf("[subscribe] discovering account from token_v2...")
		acc, err := DiscoverAccountFromToken(tokenV2)
		if err != nil {
			log.Printf("[subscribe] discovery failed: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"error": fmt.Sprintf("Failed to discover account: %v", err),
			})
			return
		}

		spaceID := acc.SpaceID
		if body.SpaceID != "" {
			spaceID = body.SpaceID
		}
		email := acc.UserEmail
		if body.Email != "" {
			email = body.Email
		}
		country := body.Country
		if country == "" {
			country = "DE"
		}

		log.Printf("[subscribe] account: %s (%s), space: %s, plan: %s", acc.UserName, email, spaceID, plan)

		// Step 2: Call Notion's updateSubscription API
		err = callNotionUpdateSubscription(tokenV2, acc.UserID, spaceID, cardToken, plan, email, acc.UserName, country, acc.ClientVersion)
		if err != nil {
			log.Printf("[subscribe] updateSubscription failed: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{
				"error": fmt.Sprintf("Subscription update failed: %v", err),
			})
			return
		}

		log.Printf("[subscribe] success: %s subscribed to %s", email, plan)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":   "ok",
			"email":    email,
			"space_id": spaceID,
			"plan":     plan,
		})
	}
}

// HandleSubscribeWithStripe creates a Stripe PaymentMethod from raw card data
// and then calls Notion's updateSubscription. This is the "one-click" endpoint
// that accepts card number, expiry, CVC directly.
//
// POST /admin/subscribe/checkout
// Body: {
//   "token_v2": "...",
//   "plan": "enterprise_monthly_eur_202505",
//   "card_number": "6233586371318910",
//   "exp_month": "04",
//   "exp_year": "31",
//   "cvc": "123",
//   "country": "DE"
// }
func HandleSubscribeCheckout(stripeKey string, auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if r.Method != "POST" {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}

		if auth.HasAdminPassword() && !auth.ValidateSession(r) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}

		var body struct {
			TokenV2    string `json:"token_v2"`
			Plan       string `json:"plan"`
			SpaceID    string `json:"space_id"`
			Country    string `json:"country"`
			PaymentMethodID string `json:"payment_method_id"` // Stripe pm_... from frontend
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		tokenV2 := strings.TrimSpace(body.TokenV2)
		pmID := strings.TrimSpace(body.PaymentMethodID)
		plan := strings.TrimSpace(body.Plan)

		if tokenV2 == "" || pmID == "" {
			http.Error(w, `{"error":"token_v2 and payment_method_id are required"}`, http.StatusBadRequest)
			return
		}
		if plan == "" {
			plan = "enterprise_monthly_eur_202505"
		}

		// Discover account
		acc, err := DiscoverAccountFromToken(tokenV2)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("Account discovery failed: %v", err)})
			return
		}

		spaceID := acc.SpaceID
		if body.SpaceID != "" {
			spaceID = body.SpaceID
		}
		country := body.Country
		if country == "" {
			country = "DE"
		}

		// Call Notion updateSubscription
		err = callNotionUpdateSubscription(tokenV2, acc.UserID, spaceID, pmID, plan, acc.UserEmail, acc.UserName, country, acc.ClientVersion)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("Subscription failed: %v", err)})
			return
		}

		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":   "ok",
			"email":    acc.UserEmail,
			"space_id": spaceID,
			"plan":     plan,
		})
	}
}

// callNotionUpdateSubscription calls POST /api/v3/updateSubscription
func callNotionUpdateSubscription(tokenV2, userID, spaceID, paymentMethodID, plan, email, name, country, clientVersion string) error {
	reqBody := map[string]interface{}{
		"billingEmail":   email,
		"customerName":   name,
		"businessName":   "",
		"addressLine1":   "",
		"addressCity":    "",
		"addressZip":     "",
		"addressState":   "",
		"addressCountry": country,
		"vatId":          "",
		"useTestClock":   false,
		"spaceId":        spaceID,
		"desiredState": map[string]interface{}{
			"items": []map[string]interface{}{
				{
					"quantity": 1,
					"price": map[string]interface{}{
						"externalId":      plan,
						"product":         extractProduct(plan),
						"billingInterval": extractInterval(plan),
						"unitAmount": map[string]interface{}{
							"currencyCode": extractCurrency(plan),
							"amount":       getPlanAmount(plan),
						},
						"state": "current",
					},
				},
			},
		},
		"paymentMethodId": paymentMethodID,
		"modalSessionId":  generateUUIDv4(),
		"clientVersion":   clientVersion,
		"from":            "plans_page",
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequest("POST", "https://app.notion.com/api/v3/updateSubscription", bytes.NewReader(bodyBytes))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Cookie", "token_v2="+tokenV2)
	req.Header.Set("User-Agent", AppConfig.Browser.UserAgent)
	req.Header.Set("x-notion-active-user-header", userID)
	req.Header.Set("x-notion-space-id", spaceID)
	req.Header.Set("notion-client-version", clientVersion)
	req.Header.Set("Origin", "https://www.notion.so")
	req.Header.Set("Referer", "https://www.notion.so/"+spaceID)

	client := getChromeHTTPClient(AppConfig.APITimeoutDuration())
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("send request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("API error %d: %s", resp.StatusCode, truncate(string(respBody), 500))
	}

	log.Printf("[subscribe] updateSubscription response: %s", truncate(string(respBody), 200))
	return nil
}

func extractProduct(plan string) string {
	switch {
	case strings.Contains(plan, "enterprise"):
		return "enterprise"
	case strings.Contains(plan, "business"):
		return "business"
	case strings.Contains(plan, "plus"):
		return "plus"
	default:
		return "enterprise"
	}
}

func extractInterval(plan string) string {
	if strings.Contains(plan, "yearly") || strings.Contains(plan, "year") {
		return "year"
	}
	return "month"
}

func extractCurrency(plan string) string {
	upper := strings.ToUpper(plan)
	if strings.Contains(upper, "EUR") {
		return "EUR"
	}
	if strings.Contains(upper, "GBP") {
		return "GBP"
	}
	return "USD"
}

// getPlanAmount returns the unit amount in cents for known plans
func getPlanAmount(plan string) int {
	amounts := map[string]int{
		"enterprise_monthly_eur_202505": 3150,
		"enterprise_yearly_eur_202505":  30600,
		"business_monthly_eur_202505":   2350,
		"business_yearly_eur_202505":    23400,
		"enterprise_monthly_usd_202505": 3200,
		"enterprise_yearly_usd_202505":  31200,
		"business_monthly_usd_202505":   2400,
		"business_yearly_usd_202505":    24000,
		"plus_monthly_eur_202407":       1150,
		"plus_yearly_eur_202407":        11400,
		"plus_monthly_usd_202407":       1200,
		"plus_yearly_usd_202407":        12000,
	}
	if a, ok := amounts[plan]; ok {
		return a
	}
	return 3150 // default enterprise monthly EUR
}
