package proxy

import (
	"errors"
	"math"
	"strings"
	"time"
)

// The Monthly bar is billingPeriodWindow, not rolling throttling, legacy basic
// credits, account.Exhausted or paid-plan premium credit balance.
func monthlySpacesExhausted(spaces []WorkspaceInfo, now int64) bool {
	if len(spaces) == 0 {
		return false
	}
	for _, s := range spaces {
		if !s.RateLimitOK || math.IsNaN(s.PeriodUsed) || math.IsInf(s.PeriodUsed, 0) || math.IsNaN(s.PeriodLimit) || math.IsInf(s.PeriodLimit, 0) || s.PeriodLimit <= 0 || s.PeriodUsed < s.PeriodLimit || (s.PeriodEndMs > 0 && s.PeriodEndMs <= now) {
			return false
		}
	}
	return true
}
func verifyMonthlyExhaustedAccount(deps *RegisterJobsDeps, email string) error {
	if deps.Pool == nil {
		return errors.New("Не удалось проверить аккаунт; удаление пропущено")
	}
	var token, userID string
	deps.Pool.mu.RLock()
	for _, a := range deps.Pool.accounts {
		a.mu.RLock()
		if strings.EqualFold(strings.TrimSpace(a.UserEmail), strings.TrimSpace(email)) {
			token = a.TokenV2
			userID = a.UserID
		}
		a.mu.RUnlock()
		if token != "" {
			break
		}
	}
	deps.Pool.mu.RUnlock()
	if token == "" {
		return errors.New("Аккаунт не найден в пуле; удаление пропущено")
	}
	discover := deps.MonthlyDiscover
	if discover == nil {
		discover = DiscoverWorkspacesFromToken
	}
	fresh, err := discover(token)
	if err != nil || fresh == nil {
		return errors.New("Не удалось перепроверить месячный лимит; аккаунт сохранён")
	}
	if !strings.EqualFold(strings.TrimSpace(fresh.UserEmail), strings.TrimSpace(email)) || (userID != "" && fresh.UserID != userID) {
		return errors.New("Идентичность аккаунта изменилась; удаление пропущено")
	}
	if !monthlySpacesExhausted(fresh.Spaces, time.Now().UnixMilli()) {
		return errors.New("Monthly ещё доступен или не проверен хотя бы в одном пространстве; аккаунт сохранён")
	}
	return nil
}
