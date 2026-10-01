package proxy

import (
	"errors"
	"math"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMonthlySpacesExhausted(t *testing.T) {
	now := time.Now().UnixMilli()
	full := WorkspaceInfo{RateLimitOK: true, PeriodUsed: 100, PeriodLimit: 100, PeriodEndMs: now + 60000}
	for _, tc := range []struct {
		name   string
		spaces []WorkspaceInfo
		want   bool
	}{
		{"exact", []WorkspaceInfo{full}, true},
		{"over", []WorkspaceInfo{{RateLimitOK: true, PeriodUsed: 101, PeriodLimit: 100}}, true},
		{"rolling only", []WorkspaceInfo{{RateLimitOK: true, RollingUsed: 100, RollingLimit: 100, PeriodUsed: 10, PeriodLimit: 100}}, false},
		{"mixed", []WorkspaceInfo{full, {RateLimitOK: true, PeriodUsed: 99.9, PeriodLimit: 100}}, false},
		{"unknown", []WorkspaceInfo{full, {}}, false},
		{"failed", []WorkspaceInfo{{PeriodUsed: 100, PeriodLimit: 100}}, false},
		{"zero cap", []WorkspaceInfo{{RateLimitOK: true, PeriodUsed: 100}}, false},
		{"expired", []WorkspaceInfo{{RateLimitOK: true, PeriodUsed: 100, PeriodLimit: 100, PeriodEndMs: now - 1}}, false},
		{"nan", []WorkspaceInfo{{RateLimitOK: true, PeriodUsed: math.NaN(), PeriodLimit: 100}}, false},
		{"empty", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := monthlySpacesExhausted(tc.spaces, now); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}
func TestGuardedMonthlyDeletionRechecksAndPreservesNonmatches(t *testing.T) {
	for _, name := range []string{"full", "available", "unknown", "identity", "upstream failure", "empty"} {
		t.Run(name, func(t *testing.T) {
			h := newRegHandlerHarness(t)
			path := filepath.Join(h.accounts, "target.json")
			if err := os.WriteFile(path, []byte(`{"user_email":"monthly@example.com","token_v2":"fake","user_id":"u"}`), 0600); err != nil {
				t.Fatal(err)
			}
			h.pool.accounts = []*Account{{UserEmail: "monthly@example.com", UserID: "u", TokenV2: "fake"}}
			calls := 0
			h.deps.MonthlyDiscover = func(token string) (*AccountWorkspaces, error) {
				calls++
				if token != "fake" {
					t.Fatal("wrong token")
				}
				out := &AccountWorkspaces{UserEmail: "monthly@example.com", UserID: "u", Spaces: []WorkspaceInfo{{RateLimitOK: true, PeriodUsed: 100, PeriodLimit: 100}}}
				switch name {
				case "available":
					out.Spaces[0].PeriodUsed = 99
				case "unknown":
					out.Spaces[0].RateLimitOK = false
				case "identity":
					out.UserID = "other"
				case "upstream failure":
					return nil, errors.New("test offline failure")
				case "empty":
					out.Spaces = nil
				}
				return out, nil
			}
			req := httptest.NewRequest("DELETE", "/admin/accounts/monthly@example.com?only_monthly_exhausted=true", nil)
			req.AddCookie(h.cookieAuth)
			w := httptest.NewRecorder()
			HandleAdminDeleteAccount(h.deps)(w, req)
			if calls != 1 {
				t.Fatal("did not recheck")
			}
			_, err := os.Stat(path)
			if name == "full" {
				if w.Code != 200 || !os.IsNotExist(err) || len(h.pool.accounts) != 0 {
					t.Fatalf("full not removed: %d %v", w.Code, err)
				}
			} else {
				if w.Code != 409 || err != nil || len(h.pool.accounts) != 1 {
					t.Fatalf("nonmatch removed: %d %v", w.Code, err)
				}
			}
		})
	}
}
