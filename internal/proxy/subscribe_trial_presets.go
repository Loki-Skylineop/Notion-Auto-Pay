package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
)

const (
	trialMethodSidebar    = "sidebar"
	trialMethodScript33   = "script33"
	trialMethodScript33V2 = "script33_v2"

	scriptTrialPlan = "business_monthly_usd_202505"
	scriptTrialID   = "business_trial_cc_upfront_14d"
	scriptTrialFrom = "business_trial_private_teamspaces_upsell"
)

var (
	trialPaymentIDPattern = regexp.MustCompile(`^pm_[A-Za-z0-9]{1,128}$`)
	trialCountryPattern   = regexp.MustCompile(`^[A-Z]{2}$`)
)

func normalizeTrialMethod(method string) (string, error) {
	method = strings.TrimSpace(method)
	if method == "" {
		method = trialMethodSidebar
	}
	switch method {
	case trialMethodSidebar, trialMethodScript33, trialMethodScript33V2:
		return method, nil
	default:
		return "", fmt.Errorf("unknown trial_method: %s", method)
	}
}

func trialMethodNeedsPayment(method string) bool {
	return method == trialMethodScript33 || method == trialMethodScript33V2
}

// Never reuse the payment identifier embedded in a captured console script.
// Stripe/Notion must still authorize the supplied method for this customer.
func validateTrialPayment(method, paymentID, country string, confirmed bool) error {
	if !trialMethodNeedsPayment(method) {
		if paymentID != "" {
			return fmt.Errorf("the card-free trial must not include a payment_method_id")
		}
		return nil
	}
	if !trialPaymentIDPattern.MatchString(paymentID) {
		return fmt.Errorf("a valid payment_method_id for your own payment method is required (pm_...)")
	}
	if !trialCountryPattern.MatchString(country) {
		return fmt.Errorf("country must be the payer's actual two-letter country code")
	}
	if !confirmed {
		return fmt.Errorf("confirm_auto_renew is required: this trial uses a payment method and may renew automatically")
	}
	return nil
}

type scriptTrialSpace struct {
	ID        string `json:"id"`
	Tier      string `json:"subscription_tier"`
	CreatedAt int64  `json:"created_time"`
	Alive     *bool  `json:"alive"`
}

// getSpaces has appeared with both value and value.value record wrappers.
func decodeScriptTrialSpace(raw json.RawMessage) (scriptTrialSpace, error) {
	for i := 0; i < 3; i++ {
		var wrapper map[string]json.RawMessage
		if err := json.Unmarshal(raw, &wrapper); err != nil {
			return scriptTrialSpace{}, err
		}
		value, ok := wrapper["value"]
		if !ok {
			var space scriptTrialSpace
			err := json.Unmarshal(raw, &space)
			return space, err
		}
		raw = value
	}
	return scriptTrialSpace{}, fmt.Errorf("unsupported workspace record")
}

// A selected workspace always wins. Automatic selection mirrors the two
// source files: newest Free workspace (script33), or newest workspace (v2).
// Unlike the original fallback, never silently change a paid subscription.
func selectScriptTrialSpace(body []byte, userID, method, requested string) (string, error) {
	var users map[string]struct {
		Spaces map[string]json.RawMessage `json:"space"`
	}
	if err := json.Unmarshal(body, &users); err != nil {
		return "", fmt.Errorf("parse getSpaces: %w", err)
	}
	user, ok := users[userID]
	if !ok || len(user.Spaces) == 0 {
		return "", fmt.Errorf("no workspaces found for the authenticated user")
	}
	var selected scriptTrialSpace
	selectedID := ""
	for id, raw := range user.Spaces {
		space, err := decodeScriptTrialSpace(raw)
		if err != nil || (space.Alive != nil && !*space.Alive) {
			continue
		}
		if requested != "" {
			if id == requested {
				selected, selectedID = space, id
				break
			}
			continue
		}
		if method == trialMethodScript33 && space.Tier != "free" {
			continue
		}
		if selectedID == "" || space.CreatedAt > selected.CreatedAt || (space.CreatedAt == selected.CreatedAt && id < selectedID) {
			selected, selectedID = space, id
		}
	}
	if selectedID == "" {
		if requested != "" {
			return "", fmt.Errorf("the selected workspace was not found for this user; no other workspace was substituted")
		}
		return "", fmt.Errorf("no suitable workspace found; choose a Free workspace explicitly")
	}
	if selected.Tier != "free" {
		return "", fmt.Errorf("the selected workspace is not Free; an existing subscription will not be changed")
	}
	return selectedID, nil
}

func discoverScriptTrialSpace(ctx context.Context, token, userID, method, requested string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, NotionAPIBase+"/getSpaces", bytes.NewBufferString("{}"))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Cookie", "token_v2="+token)
	req.Header.Set("User-Agent", AppConfig.Browser.UserAgent)
	req.Header.Set("x-notion-active-user-header", userID)
	resp, err := getChromeHTTPClient(AppConfig.APITimeoutDuration()).Do(req)
	if err != nil {
		return "", fmt.Errorf("getSpaces: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return "", fmt.Errorf("read getSpaces: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("getSpaces: %s", trialErrorMessage(resp.StatusCode, body))
	}
	return selectScriptTrialSpace(body, userID, method, requested)
}

func parseNotionTrialResult(body []byte) (*notionTrialResult, error) {
	var out notionTrialResult
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("unexpected Notion trial response")
	}
	if out.SubscriptionStatus != "trialing" {
		return nil, fmt.Errorf("Notion did not confirm a trial (subscriptionStatus=%q); check billing before trying again", out.SubscriptionStatus)
	}
	return &out, nil
}
