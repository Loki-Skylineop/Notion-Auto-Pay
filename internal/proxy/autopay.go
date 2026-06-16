package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// AutoPaySavedCard holds the raw card data the server needs to mint a FRESH
// Stripe PaymentMethod on every charge.
//
// Why store the raw card instead of a single pm_ token: a Stripe
// PaymentMethod can only be attached to ONE Stripe customer. On Notion's
// side every workspace is a separate Stripe customer, so reusing one pm_
// across workspaces fails after the first attach — which is exactly why the
// old browser-side auto-pay "didn't pay" while the manual "Оплатить" button
// (fresh card -> fresh pm_ every click) worked. Re-tokenizing per space on
// the server fixes that AND lets auto-pay run with the browser closed.
type AutoPaySavedCard struct {
	Number   string `json:"number"`
	ExpMonth string `json:"exp_month"`
	ExpYear  string `json:"exp_year"`
	CVC      string `json:"cvc"`
}

// AutoPayConfig is the persisted, server-side auto-pay state. It lives in
// accounts/.autopay.json so it survives restarts and is shared by every
// browser (the dashboard only reads/edits it via /admin/autopay).
type AutoPayConfig struct {
	Enabled         bool              `json:"enabled"`
	Plan            string            `json:"plan"`
	Country         string            `json:"country"`
	IntervalSeconds int               `json:"interval_seconds"`
	Card            *AutoPaySavedCard `json:"card,omitempty"`
	// Spaces maps a workspace space_id -> whether auto-pay is armed for it.
	Spaces map[string]bool `json:"spaces"`
	// Paid guards against charging the same space twice before the new tier
	// propagates back from Notion (space_id -> unix-ms timestamp).
	Paid map[string]int64 `json:"paid"`
}

const autoPayMinIntervalSeconds = 5

func defaultAutoPayConfig() *AutoPayConfig {
	return &AutoPayConfig{
		Enabled:         false,
		Plan:            "business_monthly_eur_202505",
		Country:         "DE",
		IntervalSeconds: 60,
		Spaces:          map[string]bool{},
		Paid:            map[string]int64{},
	}
}

// AutoPayManager owns the persisted config and the background scheduler.
type AutoPayManager struct {
	mu             sync.Mutex
	cfg            *AutoPayConfig
	path           string
	pool           *AccountPool
	stripeKey      string
	running        bool
	lastRun        time.Time
	log            []string
	lastSkipReason string
}

// NewAutoPayManager loads the persisted config (or defaults) and returns a
// manager ready to Start().
func NewAutoPayManager(pool *AccountPool, accountsDir, stripeKey string) *AutoPayManager {
	path := filepath.Join(accountsDir, ".autopay.json")
	cfg := defaultAutoPayConfig()
	if data, err := os.ReadFile(path); err == nil {
		var loaded AutoPayConfig
		if json.Unmarshal(data, &loaded) == nil {
			if loaded.Plan != "" {
				cfg.Plan = loaded.Plan
			}
			if loaded.Country != "" {
				cfg.Country = loaded.Country
			}
			if loaded.IntervalSeconds > 0 {
				cfg.IntervalSeconds = loaded.IntervalSeconds
			}
			cfg.Enabled = loaded.Enabled
			cfg.Card = loaded.Card
			if loaded.Spaces != nil {
				cfg.Spaces = loaded.Spaces
			}
			if loaded.Paid != nil {
				cfg.Paid = loaded.Paid
			}
		}
	}
	if cfg.IntervalSeconds < autoPayMinIntervalSeconds {
		cfg.IntervalSeconds = autoPayMinIntervalSeconds
	}
	hasCard := cfg.Card != nil && strings.TrimSpace(cfg.Card.Number) != ""
	armed := 0
	for _, on := range cfg.Spaces {
		if on {
			armed++
		}
	}
	log.Printf("[autopay] config loaded: enabled=%v has_card=%v plan=%s country=%s interval=%ds armed_spaces=%d paid=%d",
		cfg.Enabled, hasCard, cfg.Plan, cfg.Country, cfg.IntervalSeconds, armed, len(cfg.Paid))
	return &AutoPayManager{cfg: cfg, path: path, pool: pool, stripeKey: stripeKey}
}

// saveLocked writes the config to disk atomically. Caller MUST hold m.mu.
func (m *AutoPayManager) saveLocked() {
	if m.path == "" {
		return
	}
	out, err := json.MarshalIndent(m.cfg, "", "  ")
	if err != nil {
		return
	}
	tmp := m.path + ".tmp"
	if err := os.WriteFile(tmp, append(out, '\n'), 0o644); err != nil {
		log.Printf("[autopay] write config failed: %v", err)
		return
	}
	if err := os.Rename(tmp, m.path); err != nil {
		_ = os.Remove(tmp)
		log.Printf("[autopay] rename config failed: %v", err)
	}
}

func (m *AutoPayManager) snapshot() AutoPayConfig {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := *m.cfg
	c.Spaces = map[string]bool{}
	for k, v := range m.cfg.Spaces {
		c.Spaces[k] = v
	}
	c.Paid = map[string]int64{}
	for k, v := range m.cfg.Paid {
		c.Paid[k] = v
	}
	if m.cfg.Card != nil {
		card := *m.cfg.Card
		c.Card = &card
	}
	return c
}

func (m *AutoPayManager) markPaid(spaceID string) {
	m.mu.Lock()
	if m.cfg.Paid == nil {
		m.cfg.Paid = map[string]int64{}
	}
	m.cfg.Paid[spaceID] = time.Now().UnixMilli()
	m.saveLocked()
	m.mu.Unlock()
}

func (m *AutoPayManager) appendLog(lines []string) {
	if len(lines) == 0 {
		return
	}
	stamp := time.Now().Format("15:04:05")
	m.mu.Lock()
	entry := append([]string{stamp + " · автооплата"}, lines...)
	m.log = append(entry, m.log...)
	if len(m.log) > 40 {
		m.log = m.log[:40]
	}
	m.mu.Unlock()
}

// PublicJSON returns the config safe to expose to the dashboard (never the
// raw card — only brand/last4/has_card), plus runtime status.
func (m *AutoPayManager) PublicJSON() map[string]interface{} {
	m.mu.Lock()
	defer m.mu.Unlock()
	hasCard := m.cfg.Card != nil && strings.TrimSpace(m.cfg.Card.Number) != ""
	last4 := ""
	if hasCard {
		digits := digitsOnly(m.cfg.Card.Number)
		if len(digits) >= 4 {
			last4 = digits[len(digits)-4:]
		}
	}
	spaces := map[string]bool{}
	for k, v := range m.cfg.Spaces {
		spaces[k] = v
	}
	logCopy := make([]string, len(m.log))
	copy(logCopy, m.log)
	lastRun := ""
	if !m.lastRun.IsZero() {
		lastRun = m.lastRun.Format(time.RFC3339)
	}
	return map[string]interface{}{
		"enabled":          m.cfg.Enabled,
		"plan":             m.cfg.Plan,
		"country":          m.cfg.Country,
		"interval_seconds": m.cfg.IntervalSeconds,
		"has_card":         hasCard,
		"card_brand":       map[bool]string{true: "card", false: ""}[hasCard],
		"card_last4":       last4,
		"spaces":           spaces,
		"last_run":         lastRun,
		"log":              logCopy,
	}
}

// AutoPayPatch is the editable subset accepted by PUT /admin/autopay.
type AutoPayPatch struct {
	Enabled         *bool           `json:"enabled"`
	Plan            *string         `json:"plan"`
	Country         *string         `json:"country"`
	IntervalSeconds *int            `json:"interval_seconds"`
	Spaces          map[string]bool `json:"spaces"`
	Space           *struct {
		ID string `json:"id"`
		On bool   `json:"on"`
	} `json:"space"`
	Card      *AutoPaySavedCard `json:"card"`
	ClearCard bool              `json:"clear_card"`
}

func (m *AutoPayManager) applyPatch(p AutoPayPatch) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p.Enabled != nil {
		m.cfg.Enabled = *p.Enabled
		log.Printf("[autopay] config: enabled=%v", *p.Enabled)
	}
	if p.Plan != nil && strings.TrimSpace(*p.Plan) != "" {
		m.cfg.Plan = strings.TrimSpace(*p.Plan)
		log.Printf("[autopay] config: plan=%s", m.cfg.Plan)
	}
	if p.Country != nil && strings.TrimSpace(*p.Country) != "" {
		m.cfg.Country = strings.TrimSpace(*p.Country)
		log.Printf("[autopay] config: country=%s", m.cfg.Country)
	}
	if p.IntervalSeconds != nil {
		v := *p.IntervalSeconds
		if v < autoPayMinIntervalSeconds {
			v = autoPayMinIntervalSeconds
		}
		if v > 86400 {
			v = 86400
		}
		m.cfg.IntervalSeconds = v
		log.Printf("[autopay] config: interval=%ds", v)
	}
	if m.cfg.Spaces == nil {
		m.cfg.Spaces = map[string]bool{}
	}
	if p.Spaces != nil {
		m.cfg.Spaces = p.Spaces
	}
	if p.Space != nil && p.Space.ID != "" {
		m.cfg.Spaces[p.Space.ID] = p.Space.On
		log.Printf("[autopay] config: space %s armed=%v", truncate(p.Space.ID, 8), p.Space.On)
	}
	if p.ClearCard {
		m.cfg.Card = nil
		log.Printf("[autopay] config: card cleared")
	} else if p.Card != nil && strings.TrimSpace(p.Card.Number) != "" {
		m.cfg.Card = &AutoPaySavedCard{
			Number:   strings.TrimSpace(p.Card.Number),
			ExpMonth: strings.TrimSpace(p.Card.ExpMonth),
			ExpYear:  strings.TrimSpace(p.Card.ExpYear),
			CVC:      strings.TrimSpace(p.Card.CVC),
		}
		digits := digitsOnly(m.cfg.Card.Number)
		last4 := digits
		if len(digits) >= 4 {
			last4 = digits[len(digits)-4:]
		}
		log.Printf("[autopay] config: card saved ···· %s", last4)
	}
	m.saveLocked()
}

// Start launches the background scheduler. It sleeps the configured interval
// (in seconds, re-read every cycle so edits take effect) and then runs a scan.
func (m *AutoPayManager) Start() {
	go func() {
		log.Printf("[autopay] scheduler started")
		for {
			cfg := m.snapshot()
			interval := cfg.IntervalSeconds
			if interval < autoPayMinIntervalSeconds {
				interval = autoPayMinIntervalSeconds
			}
			time.Sleep(time.Duration(interval) * time.Second)
			cfg = m.snapshot()
			if cfg.Enabled && cfg.Card != nil {
				m.runOnce()
				continue
			}
			// Log WHY we're not paying — but only when the reason changes, so
			// a 5s interval doesn't flood the console.
			reason := "выключено в настройках"
			if cfg.Enabled && cfg.Card == nil {
				reason = "карта не задана (введите карту в «Настроить карту и план»)"
			}
			m.mu.Lock()
			changed := m.lastSkipReason != reason
			m.lastSkipReason = reason
			m.mu.Unlock()
			if changed {
				log.Printf("[autopay] планировщик не платит: %s", reason)
			}
		}
	}()
}

// TriggerRun runs a single scan in the background (used by POST
// /admin/autopay/run). Deduplicated so overlapping triggers don't pile up.
func (m *AutoPayManager) TriggerRun() bool {
	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		log.Printf("[autopay] ручной запуск пропущен: скан уже идёт")
		return false
	}
	m.mu.Unlock()
	log.Printf("[autopay] ручной запуск скана")
	go m.runOnce()
	return true
}

// runOnce scans every pooled account's workspaces and pays each armed,
// still-free space using a freshly minted PaymentMethod. It logs every
// decision to the console so it's clear why a free space was or wasn't paid.
func (m *AutoPayManager) runOnce() {
	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		return
	}
	m.running = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.running = false
		m.lastRun = time.Now()
		m.mu.Unlock()
	}()

	cfg := m.snapshot()
	if !cfg.Enabled || cfg.Card == nil {
		log.Printf("[autopay] скан пропущен: enabled=%v has_card=%v", cfg.Enabled, cfg.Card != nil)
		return
	}

	armed := 0
	for _, on := range cfg.Spaces {
		if on {
			armed++
		}
	}
	log.Printf("[autopay] === скан старт === план=%s страна=%s интервал=%ds отмечено «Авто»=%d", cfg.Plan, cfg.Country, cfg.IntervalSeconds, armed)

	if armed == 0 {
		log.Printf("[autopay] ⚠ ни одно пространство не отмечено «Авто» — оплачивать нечего. Отметьте нужные пространства галочкой «Авто».")
	}

	// Collect tokens from the live pool (same package, so we can read the
	// unexported fields directly under the pool lock).
	m.pool.mu.RLock()
	tokens := make([]string, 0, len(m.pool.accounts))
	for _, a := range m.pool.accounts {
		if strings.TrimSpace(a.TokenV2) != "" {
			tokens = append(tokens, a.TokenV2)
		}
	}
	m.pool.mu.RUnlock()
	log.Printf("[autopay] аккаунтов в пуле: %d", len(tokens))

	var msgs []string
	totFree, totArmedFree, totPaid := 0, 0, 0
	for _, token := range tokens {
		ws, err := DiscoverWorkspacesFromToken(token)
		if err != nil {
			log.Printf("[autopay] ✗ discover ошибка: %v", err)
			msgs = append(msgs, "✗ discover: "+err.Error())
			continue
		}

		accFree := 0
		for _, sp := range ws.Spaces {
			tier := strings.ToLower(strings.TrimSpace(sp.PlanType))
			if !sp.IsSubscribed && (tier == "" || tier == "free" || tier == "personal") {
				accFree++
			}
		}
		totFree += accFree
		log.Printf("[autopay] аккаунт %s: пространств=%d, из них free=%d", ws.UserEmail, len(ws.Spaces), accFree)

		for _, sp := range ws.Spaces {
			name := sp.Name
			if name == "" {
				name = "Workspace"
			}
			shortID := truncate(sp.SpaceID, 8)
			tier := strings.ToLower(strings.TrimSpace(sp.PlanType))
			isFree := !sp.IsSubscribed && (tier == "" || tier == "free" || tier == "personal")
			armedOn := cfg.Spaces[sp.SpaceID]

			if !armedOn {
				if isFree {
					log.Printf("[autopay]   – %s (%s): free, но НЕ отмечено «Авто» — пропуск", name, shortID)
				}
				continue
			}
			if !isFree {
				log.Printf("[autopay]   – %s (%s): уже платный (tier=%q) — пропуск", name, shortID, tier)
				continue
			}
			totArmedFree++
			if ts, ok := cfg.Paid[sp.SpaceID]; ok {
				log.Printf("[autopay]   – %s (%s): уже оплачен ранее (%s) — пропуск", name, shortID, time.UnixMilli(ts).Format("15:04:05"))
				continue
			}

			log.Printf("[autopay]   → плачу %s (%s): план %s, создаю токен карты...", name, shortID, cfg.Plan)
			pmID, err := createStripePaymentMethod(m.stripeKey, cfg.Country, *cfg.Card)
			if err != nil {
				log.Printf("[autopay]   ✗ %s (%s): Stripe отклонил карту: %v", name, shortID, err)
				msgs = append(msgs, "✗ "+name+": карта — "+err.Error())
				continue
			}
			log.Printf("[autopay]   • %s (%s): карта токенизирована (%s), отправляю в Notion...", name, shortID, pmID)
			err = callNotionUpdateSubscription(token, ws.UserID, sp.SpaceID, pmID, cfg.Plan, ws.UserEmail, ws.UserName, cfg.Country, DefaultClientVersion)
			if err != nil {
				log.Printf("[autopay]   ✗ %s (%s): Notion отклонил оплату: %v", name, shortID, err)
				msgs = append(msgs, "✗ "+name+": "+err.Error())
				continue
			}
			log.Printf("[autopay]   ✓ %s (%s): ОПЛАЧЕНО — план %s", name, shortID, cfg.Plan)
			msgs = append(msgs, "✓ "+name+": "+cfg.Plan)
			m.markPaid(sp.SpaceID)
			totPaid++
		}
	}

	log.Printf("[autopay] === скан завершён === free всего=%d, free+«Авто»=%d, оплачено сейчас=%d", totFree, totArmedFree, totPaid)
	if len(msgs) > 0 {
		m.appendLog(msgs)
	}
}

// createStripePaymentMethod mints a fresh Stripe PaymentMethod from raw card
// data using the PUBLISHABLE key — this is the exact same public endpoint
// Stripe.js calls in the browser, so a pk_live_ key is sufficient and no
// secret key is needed.
func createStripePaymentMethod(stripeKey, country string, card AutoPaySavedCard) (string, error) {
	if strings.TrimSpace(stripeKey) == "" {
		return "", fmt.Errorf("stripe key not configured")
	}
	form := url.Values{}
	form.Set("type", "card")
	form.Set("card[number]", digitsOnly(card.Number))
	form.Set("card[exp_month]", strings.TrimSpace(card.ExpMonth))
	form.Set("card[exp_year]", strings.TrimSpace(card.ExpYear))
	form.Set("card[cvc]", strings.TrimSpace(card.CVC))
	if strings.TrimSpace(country) != "" {
		form.Set("billing_details[address][country]", strings.TrimSpace(country))
	}

	req, err := http.NewRequest("POST", "https://api.stripe.com/v1/payment_methods", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(stripeKey))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var out struct {
		ID    string `json:"id"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &out)
	if out.Error != nil && out.Error.Message != "" {
		return "", fmt.Errorf(out.Error.Message)
	}
	if resp.StatusCode != 200 || out.ID == "" {
		return "", fmt.Errorf("stripe error %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return out.ID, nil
}

func digitsOnly(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// HandleAutoPay serves GET (read config) and PUT (edit config) on
// /admin/autopay.
func HandleAutoPay(m *AutoPayManager, auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if auth.HasAdminPassword() && !auth.ValidateSession(r) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		switch r.Method {
		case http.MethodGet:
			json.NewEncoder(w).Encode(m.PublicJSON())
		case http.MethodPut:
			var patch AutoPayPatch
			if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
				http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
				return
			}
			m.applyPatch(patch)
			json.NewEncoder(w).Encode(m.PublicJSON())
		default:
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		}
	}
}

// HandleAutoPayRun triggers an immediate scan (POST /admin/autopay/run).
func HandleAutoPayRun(m *AutoPayManager, auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodPost {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		if auth.HasAdminPassword() && !auth.ValidateSession(r) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		started := m.TriggerRun()
		json.NewEncoder(w).Encode(map[string]bool{"started": started})
	}
}
