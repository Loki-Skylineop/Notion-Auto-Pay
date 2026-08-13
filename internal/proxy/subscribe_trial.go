package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// Free-trial activation, reverse engineered from a captured browser session
// (HAR export of app.notion.com). The trial is NOT a separate endpoint: Notion
// reuses POST /api/v3/updateSubscription, but the payload carries `trialData`
// plus `desiredState.trialEnd` and NO paymentMethodId at all:
//
//	{
//	  "captchaToken": "P1_...",
//	  "spaceId": "<space uuid>",
//	  "desiredState": {
//	    "items": [{"quantity": 1, "price": {...}}],
//	    "trialEnd": "2026-08-26T04:24:09.952+03:00"
//	  },
//	  "modalSessionId": "<uuid v4>",
//	  "clientVersion": "23.13.20260811.2055",
//	  "trialData": {"id": "custom_agents_business_reverse_14d",
//	                "from": "new_custom_agents_sidebar", "autoConvert": false},
//	  "from": "new_custom_agents_sidebar"
//	}
//
// Success answers 200 {"subscriptionStatus":"trialing","invoiceUrl":"..."};
// a refusal answers 400 {"debugMessage":"Trial activation is not allowed."}.
// In the capture the very same request was rejected four times before it went
// through, so we retry a couple of times before giving up.
const (
	defaultTrialID   = "custom_agents_business_reverse_14d"
	defaultTrialFrom = "new_custom_agents_sidebar"
	defaultTrialPlan = "business_monthly_eur_202505"
	defaultTrialDays = 14
	maxTrialDays     = 90
	trialMaxAttempts = 3
	trialRetryDelay  = 2 * time.Second
	// Notion sends RFC3339 with milliseconds and a numeric zone offset.
	trialTimeLayout = "2006-01-02T15:04:05.000-07:00"
)

// TrialResponse is what /admin/subscribe/trial answers to the dashboard.
type TrialResponse struct {
	Status             string `json:"status,omitempty"`
	Email              string `json:"email,omitempty"`
	SpaceID            string `json:"space_id,omitempty"`
	Plan               string `json:"plan,omitempty"`
	Days               int    `json:"days,omitempty"`
	TrialEnd           string `json:"trial_end,omitempty"`
	SubscriptionStatus string `json:"subscription_status,omitempty"`
	InvoiceURL         string `json:"invoice_url,omitempty"`
	Attempts           int    `json:"attempts,omitempty"`
	Error              string `json:"error,omitempty"`
}

// trialRequest bundles everything a single trial call needs.
type trialRequest struct {
	TokenV2       string
	UserID        string
	SpaceID       string
	Plan          string
	TrialEnd      string
	TrialID       string
	From          string
	CaptchaToken  string
	ClientVersion string
}

// notionTrialResult is the 200 payload Notion returns for a started trial.
type notionTrialResult struct {
	SubscriptionStatus string `json:"subscriptionStatus"`
	InvoiceURL         string `json:"invoiceUrl"`
}

func writeTrialJSON(w http.ResponseWriter, status int, resp TrialResponse) {
	if status != http.StatusOK {
		w.WriteHeader(status)
	}
	_ = json.NewEncoder(w).Encode(resp)
}

// HandleSubscribeTrial activates a Notion free trial for one workspace without
// any card at all.
//
// POST /admin/subscribe/trial
// Body: {token_v2, space_id, plan, days, captcha_token, trial_id, from}
func HandleSubscribeTrial(auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodPost {
			writeTrialJSON(w, http.StatusMethodNotAllowed, TrialResponse{Error: "method not allowed"})
			return
		}
		if auth.HasAdminPassword() && !auth.ValidateSession(r) {
			writeTrialJSON(w, http.StatusUnauthorized, TrialResponse{Error: "unauthorized"})
			return
		}

		var body struct {
			TokenV2      string `json:"token_v2"`
			SpaceID      string `json:"space_id"`
			Plan         string `json:"plan"`
			Days         int    `json:"days"`
			CaptchaToken string `json:"captcha_token"`
			TrialID      string `json:"trial_id"`
			From         string `json:"from"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeTrialJSON(w, http.StatusBadRequest, TrialResponse{Error: "invalid request body"})
			return
		}

		token := strings.TrimSpace(body.TokenV2)
		if token == "" {
			writeTrialJSON(w, http.StatusBadRequest, TrialResponse{Error: "token_v2 is required"})
			return
		}
		plan := strings.TrimSpace(body.Plan)
		if plan == "" {
			plan = defaultTrialPlan
		}
		days := body.Days
		if days <= 0 {
			days = defaultTrialDays
		}
		if days > maxTrialDays {
			days = maxTrialDays
		}
		trialID := strings.TrimSpace(body.TrialID)
		if trialID == "" {
			trialID = defaultTrialID
		}
		from := strings.TrimSpace(body.From)
		if from == "" {
			from = defaultTrialFrom
		}

		acc, err := DiscoverAccountFromToken(token)
		if err != nil {
			writeTrialJSON(w, http.StatusBadRequest, TrialResponse{Error: fmt.Sprintf("account discovery failed: %v", err)})
			return
		}
		spaceID := strings.TrimSpace(body.SpaceID)
		if spaceID == "" {
			spaceID = acc.SpaceID
		}
		if spaceID == "" {
			writeTrialJSON(w, http.StatusBadRequest, TrialResponse{Error: "space_id is required"})
			return
		}
		clientVersion := strings.TrimSpace(acc.ClientVersion)
		if clientVersion == "" {
			clientVersion = DefaultClientVersion
		}

		log.Printf("[trial] space=%s plan=%s days=%d captcha=%v (%s)", truncate(spaceID, 8), plan, days, strings.TrimSpace(body.CaptchaToken) != "", acc.UserEmail)

		var (
			out      *notionTrialResult
			lastErr  error
			attempts int
			trialEnd string
		)
		for attempt := 1; attempt <= trialMaxAttempts; attempt++ {
			attempts = attempt
			trialEnd = time.Now().Add(time.Duration(days) * 24 * time.Hour).Format(trialTimeLayout)
			out, lastErr = callNotionTrialSubscription(trialRequest{
				TokenV2:       token,
				UserID:        acc.UserID,
				SpaceID:       spaceID,
				Plan:          plan,
				TrialEnd:      trialEnd,
				TrialID:       trialID,
				From:          from,
				CaptchaToken:  strings.TrimSpace(body.CaptchaToken),
				ClientVersion: clientVersion,
			})
			if lastErr == nil {
				break
			}
			log.Printf("[trial]   attempt %d/%d failed: %v", attempt, trialMaxAttempts, lastErr)
			if attempt < trialMaxAttempts {
				time.Sleep(trialRetryDelay)
			}
		}
		if lastErr != nil {
			writeTrialJSON(w, http.StatusInternalServerError, TrialResponse{
				SpaceID:  spaceID,
				Plan:     plan,
				Days:     days,
				Attempts: attempts,
				Error:    lastErr.Error(),
			})
			return
		}

		subStatus := ""
		invoice := ""
		if out != nil {
			subStatus = out.SubscriptionStatus
			invoice = out.InvoiceURL
		}
		log.Printf("[trial]   OK space=%s status=%q until %s", truncate(spaceID, 8), subStatus, trialEnd)
		writeTrialJSON(w, http.StatusOK, TrialResponse{
			Status:             "ok",
			Email:              acc.UserEmail,
			SpaceID:            spaceID,
			Plan:               plan,
			Days:               days,
			TrialEnd:           trialEnd,
			SubscriptionStatus: subStatus,
			InvoiceURL:         invoice,
			Attempts:           attempts,
		})
	}
}

// callNotionTrialSubscription replays the captured trial payload once.
func callNotionTrialSubscription(req trialRequest) (*notionTrialResult, error) {
	price := map[string]interface{}{
		"externalId":      req.Plan,
		"product":         extractProduct(req.Plan),
		"billingInterval": extractInterval(req.Plan),
		"unitAmount": map[string]interface{}{
			"currencyCode": extractCurrency(req.Plan),
			"amount":       getPlanAmount(req.Plan),
		},
		"state": "current",
	}
	payload := map[string]interface{}{
		"spaceId": req.SpaceID,
		"desiredState": map[string]interface{}{
			"items":    []map[string]interface{}{{"quantity": 1, "price": price}},
			"trialEnd": req.TrialEnd,
		},
		"modalSessionId": generateUUIDv4(),
		"clientVersion":  req.ClientVersion,
		"trialData": map[string]interface{}{
			"id":          req.TrialID,
			"from":        req.From,
			"autoConvert": false,
		},
		"from": req.From,
	}
	// The web client always ships an hCaptcha token here. We cannot solve one
	// server side, so it stays optional: forward it verbatim when the dashboard
	// supplies a fresh one, otherwise try without.
	if req.CaptchaToken != "" {
		payload["captchaToken"] = req.CaptchaToken
	}

	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	httpReq, err := http.NewRequest("POST", NotionAPIBase+"/updateSubscription", bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	origin := notionWebOrigin()
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("Cookie", "token_v2="+req.TokenV2)
	httpReq.Header.Set("User-Agent", AppConfig.Browser.UserAgent)
	if req.UserID != "" {
		httpReq.Header.Set("x-notion-active-user-header", req.UserID)
	}
	httpReq.Header.Set("x-notion-space-id", req.SpaceID)
	httpReq.Header.Set("notion-client-version", req.ClientVersion)
	httpReq.Header.Set("notion-audit-log-platform", "web")
	httpReq.Header.Set("Origin", origin)
	httpReq.Header.Set("Referer", origin+"/"+strings.ReplaceAll(req.SpaceID, "-", ""))

	client := getChromeHTTPClient(AppConfig.APITimeoutDuration())
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("send request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s", trialErrorMessage(resp.StatusCode, respBody))
	}
	var out notionTrialResult
	if err := json.Unmarshal(respBody, &out); err != nil {
		return nil, fmt.Errorf("unexpected Notion response: %s", truncate(string(respBody), 200))
	}
	return &out, nil
}

// notionWebOrigin derives the web origin from the configured API base.
func notionWebOrigin() string {
	base := strings.TrimSpace(NotionAPIBase)
	if i := strings.Index(base, "/api/"); i > 0 {
		return base[:i]
	}
	return "https://www.notion.so"
}

// trialErrorMessage turns a Notion error payload into a readable reason.
func trialErrorMessage(status int, body []byte) string {
	var e struct {
		Name         string `json:"name"`
		Message      string `json:"message"`
		DebugMessage string `json:"debugMessage"`
	}
	msg := ""
	if err := json.Unmarshal(body, &e); err == nil {
		if e.DebugMessage != "" {
			msg = e.DebugMessage
		} else if e.Message != "" {
			msg = e.Message
		}
	}
	if msg == "" {
		msg = truncate(strings.TrimSpace(string(body)), 300)
	}
	lower := strings.ToLower(msg)
	switch {
	case strings.Contains(lower, "trial activation is not allowed"):
		return fmt.Sprintf("Notion %d: %s (trial already used for this account/space, or a fresh captchaToken is required)", status, msg)
	case strings.Contains(lower, "captcha"):
		return fmt.Sprintf("Notion %d: %s (paste a fresh hCaptcha token)", status, msg)
	}
	return fmt.Sprintf("Notion %d: %s", status, msg)
}
