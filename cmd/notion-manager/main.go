package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"notion-manager/internal/proxy"
	"notion-manager/internal/regjob"
	"notion-manager/internal/regjob/providers"
	"notion-manager/internal/regjob/providers/microsoft"
)

func requiresAPIKey(path string) bool {
	return path == "/models" || strings.HasPrefix(path, "/v1/")
}

func apiKeyAuthMiddleware(apiKey string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !requiresAPIKey(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}

		var key string
		if bearer := r.Header.Get("Authorization"); bearer != "" {
			key = strings.TrimPrefix(bearer, "Bearer ")
			if key == bearer {
				key = ""
			}
		}
		if key == "" {
			key = r.Header.Get("x-api-key")
		}
		if key == "" {
			http.Error(w, `{"error":{"message":"missing api key, use 'Authorization: Bearer <key>' or 'x-api-key: <key>'","type":"auth_error"}}`, http.StatusUnauthorized)
			return
		}
		if key != apiKey {
			http.Error(w, `{"error":{"message":"invalid api key","type":"auth_error"}}`, http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func newMux(pool *proxy.AccountPool, accountsDir string, apiKey string, dashAuth *proxy.DashboardAuth, usageStats *proxy.UsageStats, regDeps *proxy.RegisterJobsDeps, autoPay *proxy.AutoPayManager) *http.ServeMux {
	mux := http.NewServeMux()

	// Anthropic + OpenAI-compatible API endpoints
	mux.HandleFunc("/v1/messages", proxy.HandleAnthropicMessages(pool))
	mux.HandleFunc("/v1/chat/completions", proxy.HandleOpenAIChatCompletions(pool))
	mux.HandleFunc("/v1/responses", proxy.HandleOpenAIResponses(pool))
	mux.HandleFunc("/v1/models", proxy.HandlePublicModels(pool))
	mux.HandleFunc("/models", proxy.HandlePublicModels(pool))

	// Health check with quota details
	mux.HandleFunc("/health", proxy.HandleHealth(pool))

	// Admin API endpoints
	mux.HandleFunc("/admin/accounts", proxy.HandleAdminAccounts(pool, dashAuth))
	mux.HandleFunc("/admin/accounts/add", proxy.HandleAddAccount(pool, accountsDir, dashAuth))
	mux.HandleFunc("/admin/accounts/delete", proxy.HandleDeleteAccount(pool, accountsDir, dashAuth))
	mux.HandleFunc("/admin/models", proxy.HandleAdminModels(pool, dashAuth))
	mux.HandleFunc("/admin/refresh", proxy.HandleAdminRefresh(pool, accountsDir, dashAuth))
	mux.HandleFunc("/admin/settings", proxy.HandleAdminSettings("config.yaml", dashAuth))
	mux.HandleFunc("/admin/stats", proxy.HandleAdminStats(usageStats, dashAuth))

	// Bulk Microsoft-SSO registration. The legacy synchronous endpoint is
	// kept for parity with the dashboard's older "submit + wait" UI; the
	// async Job-based endpoints power the new register drawer (with SSE
	// progress at /admin/register/jobs/{id}/events).
	mux.HandleFunc("/admin/register", proxy.HandleAdminRegister(pool, accountsDir, dashAuth))
	mux.HandleFunc("/admin/register/providers", proxy.HandleAdminRegisterProviders(regDeps))
	mux.HandleFunc("/admin/register/start", proxy.HandleAdminRegisterStart(regDeps))
	mux.HandleFunc("/admin/register/jobs", proxy.HandleAdminRegisterJobsList(regDeps))
	mux.HandleFunc("/admin/register/jobs/", proxy.HandleAdminRegisterJobsRouter(regDeps))
	// REST-style DELETE /admin/accounts/{email}. Coexists with the older
	// POST /admin/accounts/delete handler — Go's mux prefers the more
	// specific exact-match route, so /add and /delete still win over the
	// catch-all /admin/accounts/.
	mux.HandleFunc("/admin/accounts/", proxy.HandleAdminDeleteAccount(regDeps))

	// Subscription payment endpoints
	mux.HandleFunc("/admin/subscribe", proxy.HandleSubscribe(accountsDir, dashAuth))
	mux.HandleFunc("/admin/subscribe/checkout", proxy.HandleSubscribeCheckout(proxy.AppConfig.Stripe.Key, dashAuth))

	// Workspace discovery endpoint
	mux.HandleFunc("/admin/discover", proxy.HandleDiscoverWorkspaces(dashAuth))

	// Server-side auto-pay config + manual trigger. The actual paying is done
	// by the background scheduler (AutoPayManager.Start) so it keeps running
	// even with the dashboard/browser closed.
	mux.HandleFunc("/admin/autopay", proxy.HandleAutoPay(autoPay, dashAuth))
	mux.HandleFunc("/admin/autopay/run", proxy.HandleAutoPayRun(autoPay, dashAuth))
	// Pay a single workspace using the server-saved card (manual button in
	// the Subscribe modal, so the user doesn't have to re-type the card).
	mux.HandleFunc("/admin/autopay/pay-space", proxy.HandleAutoPayPaySpace(autoPay, dashAuth))

	// Dashboard (React SPA with embedded API key + auth)
	mux.Handle("/dashboard/", proxy.HandleDashboard(apiKey, dashAuth))
	mux.HandleFunc("/dashboard", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/dashboard/", http.StatusMovedPermanently)
	})

	// Proxy start: create targeted session for a specific account (requires dashboard auth)
	rp := proxy.NewReverseProxy(pool)
	mux.HandleFunc("/proxy/start", proxy.HandleProxyStart(pool, rp, dashAuth))

	// Catch-all: reverse proxy for paths with valid np_session, 404 for everything else
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rp.ServeHTTP(w, r)
	}))

	return mux
}

func main() {
	// --password (or DASHBOARD_PASSWORD env) protects the web dashboard with a
	// login prompt. When neither is set, the dashboard stays open.
	passwordFlag := flag.String("password", "", "Dashboard login password. If set (or via DASHBOARD_PASSWORD env), the web panel requires this password to log in.")
	flag.Parse()

	cfg, err := proxy.LoadConfig("config.yaml")
	if err != nil {
		log.Fatalf("[config] %v", err)
	}

	proxy.EnsureApiKey(cfg, "config.yaml")

	// Dashboard password resolution.
	// Priority: --password CLI flag > DASHBOARD_PASSWORD env > config.yaml admin_password.
	// A password supplied via flag/env is hashed in memory only and is never
	// written back to config.yaml. A password set in config.yaml keeps the
	// existing behavior of being hashed-in-place on first run. When no password
	// is configured anywhere, the dashboard is served without a login prompt.
	dashPassword := strings.TrimSpace(*passwordFlag)
	if dashPassword == "" {
		dashPassword = strings.TrimSpace(os.Getenv("DASHBOARD_PASSWORD"))
	}

	var dashPasswordHash string
	switch {
	case dashPassword != "":
		dashPasswordHash = proxy.HashAdminPassword(dashPassword)
		log.Printf("[config] dashboard password set via command line/env — web panel is password-protected")
	case cfg.Server.AdminPassword != "":
		proxy.EnsureAdminPassword(cfg, "config.yaml")
		dashPasswordHash = cfg.Server.AdminPassword
		log.Printf("[config] dashboard password loaded from config.yaml — web panel is password-protected")
	default:
		log.Printf("[config] no dashboard password configured — web panel is OPEN (pass --password=<pw> to protect it)")
	}

	proxy.ApplyConfig(cfg)

	port := cfg.Server.Port
	accountsDir := cfg.Server.AccountsDir
	tokenFile := cfg.Server.TokenFile

	pool := proxy.NewAccountPool()

	if _, err := os.Stat(accountsDir); err == nil {
		if err := pool.LoadFromDir(accountsDir); err != nil {
			log.Printf("[warn] %v", err)
		}
	}

	if pool.Count() == 0 {
		tokenV2 := os.Getenv("NOTION_TOKEN_V2")
		if tokenV2 == "" {
			if data, err := os.ReadFile(tokenFile); err == nil {
				tokenV2 = strings.TrimSpace(string(data))
			}
		}
		if tokenV2 != "" {
			pool.LoadSingle(tokenFile)
		}
	}

	if pool.Count() == 0 {
		log.Printf("[warn] No accounts found. Place account JSON files in %s/ to enable API and proxy.", accountsDir)
	}

	// Startup refresh: kick off a quota+models check in the background so
	// the HTTP listener can come up immediately even with large pools.
	if pool.Count() > 0 {
		log.Printf("[startup] kicking off background quota refresh for %d account(s)", pool.Count())
		go pool.RefreshAll(accountsDir)
	}

	pool.StartRefreshLoop(cfg.RefreshInterval(), accountsDir)

	// Token usage statistics — persisted next to the account JSONs so they
	// share a backup target with .register_history.json.
	statsPath := filepath.Join(accountsDir, ".token_stats.json")
	usageStats := proxy.InitUsageStats(statsPath)
	usageStats.StartFlushLoop(5 * time.Second)

	// Server-side auto-pay: loads accounts/.autopay.json and runs an
	// unattended scan loop (interval is configured in SECONDS via the
	// dashboard). Re-tokenizes the saved card per workspace so it works
	// with the browser closed.
	autoPay := proxy.NewAutoPayManager(pool, accountsDir, cfg.Stripe.Key)
	autoPay.Start()

	// Async batch-register store + provider registry.
	regStore, err := regjob.NewStore(cfg.Register.HistoryFile, cfg.Register.HistoryMemoryCap)
	if err != nil {
		log.Fatalf("[regjob] init store at %s: %v", cfg.Register.HistoryFile, err)
	}
	registry := providers.NewRegistry()
	registry.Register(microsoft.New())

	apiKey := cfg.Server.ApiKey
	dashAuth := proxy.NewDashboardAuth(dashPasswordHash, apiKey)

	regDeps := &proxy.RegisterJobsDeps{
		Pool:        pool,
		AccountsDir: accountsDir,
		Store:       regStore,
		Providers:   registry,
		Auth:        dashAuth,
	}

	cors := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, X-Web-Search, X-Workspace-Search")
			if r.Method == "OPTIONS" {
				w.WriteHeader(http.StatusOK)
				return
			}
			next.ServeHTTP(w, r)
		})
	}

	mux := newMux(pool, accountsDir, apiKey, dashAuth, usageStats, regDeps, autoPay)

	dashStatus := "OPEN (no password)"
	if dashPasswordHash != "" {
		dashStatus = "password protected"
	}

	log.Printf("=== notion-manager ===")
	log.Printf("Listening on :%s", port)
	log.Printf("Accounts: %d", pool.Count())
	log.Printf("API Key: %s", apiKey)
	log.Printf("Dashboard: %s", dashStatus)
	log.Printf("Endpoints:")
	log.Printf("  GET  /dashboard/                  (Dashboard UI)")
	log.Printf("  GET  /proxy/start                 (Open proxy for account)")
	log.Printf("  POST /v1/messages                 (Anthropic Messages API)")
	log.Printf("  POST /v1/chat/completions         (OpenAI Chat Completions API)")
	log.Printf("  POST /v1/responses                (OpenAI Responses API)")
	log.Printf("  GET  /v1/models                   (OpenAI models API)")
	log.Printf("  GET  /models                      (OpenAI models alias)")
	log.Printf("  GET  /health")
	log.Printf("  GET  /admin/accounts")
	log.Printf("  GET  /admin/models")
	log.Printf("  GET  /admin/settings              (search/proxy/ASK settings)")
	log.Printf("  GET  /admin/stats                 (token usage stats)")
	log.Printf("  GET  /admin/autopay               (server auto-pay config)")
	log.Printf("  POST /admin/autopay/run           (trigger auto-pay scan now)")
	log.Printf("  POST /admin/autopay/pay-space     (pay one workspace with saved card)")
	log.Printf("  POST /admin/register              (bulk MS-SSO register, sync)")
	log.Printf("  POST /admin/register/start        (async job)")
	log.Printf("  GET  /admin/register/jobs/{id}/events (SSE progress)")
	log.Printf("  GET  /ai                          (Reverse Proxy -> notion.so)")

	if err := http.ListenAndServe(":"+port, cors(apiKeyAuthMiddleware(apiKey, mux))); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}
