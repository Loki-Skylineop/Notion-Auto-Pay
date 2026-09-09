package proxy

// API routing.
//
// Which Notion workspace serves the Anthropic-compatible /v1 endpoints is an
// explicit, persisted decision, and this file owns it.
//
// Routing is persisted in config.yaml as:
//
//	server.api_routing:       auto | pinned
//	server.api_space:         space_id of the pinned workspace
//	server.api_space_name:    workspace name, dashboard display only
//	server.api_space_view_id: space view id belonging to that workspace
//	server.api_account:       email of the account that owns the workspace
//
// A pin targets a WORKSPACE, not an account. Notion meters AI usage per space
// and every inference request carries exactly one space_id, so "where do the
// messages go" is only meaningful at workspace granularity. One account can
// own several workspaces, which makes an account pin ambiguous. The owning
// account is therefore derived from the workspace and stored next to it, so a
// restart resolves the pin without waiting for a discovery pass.
//
// A pool account only remembers the single space that discovery picked as
// "best". When the pinned workspace is a different one, applyPinnedSpace
// rewrites the account's active space before the request is built, and it does
// so on every attempt because a background refresh can silently revert it.

import (
	"log"
	"strings"
	"sync"
)

const (
	// APIRoutingAuto lets the pool choose the account.
	APIRoutingAuto = "auto"
	// APIRoutingPinned forces a single workspace for new conversations.
	APIRoutingPinned = "pinned"
)

var (
	apiRoutingMu          sync.RWMutex
	apiRoutingMode        = APIRoutingAuto
	apiRoutingEmail       string
	apiRoutingSpaceID     string
	apiRoutingSpaceName   string
	apiRoutingSpaceViewID string
)

// APIRouting returns the routing mode and the email of the account that owns
// the pinned workspace.
func APIRouting() (mode string, email string) {
	apiRoutingMu.RLock()
	defer apiRoutingMu.RUnlock()
	return apiRoutingMode, apiRoutingEmail
}

// APIRoutingSpace returns the pinned workspace: its id, its display name and
// the space view id that belongs to it.
func APIRoutingSpace() (spaceID, spaceName, spaceViewID string) {
	apiRoutingMu.RLock()
	defer apiRoutingMu.RUnlock()
	return apiRoutingSpaceID, apiRoutingSpaceName, apiRoutingSpaceViewID
}

// SetAPIRouting normalises and applies a routing decision in memory. The
// workspace and account are kept even in auto mode so the dashboard can
// remember the last choice and pre-select it.
func SetAPIRouting(mode, email, spaceID, spaceName, spaceViewID string) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode != APIRoutingPinned {
		mode = APIRoutingAuto
	}
	apiRoutingMu.Lock()
	apiRoutingMode = mode
	apiRoutingEmail = strings.TrimSpace(email)
	apiRoutingSpaceID = strings.TrimSpace(spaceID)
	apiRoutingSpaceName = strings.TrimSpace(spaceName)
	apiRoutingSpaceViewID = strings.TrimSpace(spaceViewID)
	apiRoutingMu.Unlock()
}

// InitAPIRoutingFromConfig seeds the in-memory decision from config.yaml and
// normalises the config struct so a later persist writes clean values. main.go
// calls this once during startup.
func InitAPIRoutingFromConfig() {
	SetAPIRouting(
		AppConfig.Server.APIRouting,
		AppConfig.Server.APIAccount,
		AppConfig.Server.APISpace,
		AppConfig.Server.APISpaceName,
		AppConfig.Server.APISpaceView,
	)
	mode, email := APIRouting()
	spaceID, spaceName, spaceViewID := APIRoutingSpace()
	AppConfig.Server.APIRouting = mode
	AppConfig.Server.APIAccount = email
	AppConfig.Server.APISpace = spaceID
	AppConfig.Server.APISpaceName = spaceName
	AppConfig.Server.APISpaceView = spaceViewID
	switch {
	case mode == APIRoutingPinned && spaceID != "":
		log.Printf("[api] routing: pinned to workspace %s (account %s)", describeSpace(spaceName, spaceID), email)
	case mode == APIRoutingPinned && email != "":
		// Legacy config written before workspace pinning existed.
		log.Printf("[api] routing: pinned to account %s (no workspace recorded, set server.api_space in config.yaml)", email)
	default:
		log.Printf("[api] routing: auto (highest remaining quota first)")
	}
}


// describeSpace renders a workspace for logs and for the dashboard's
// "effective" field: its name when known, a short id otherwise.
func describeSpace(name, id string) string {
	name = strings.TrimSpace(name)
	if name != "" {
		return name
	}
	id = strings.TrimSpace(id)
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// GetBySpaceID returns the pool account whose active workspace is spaceID.
func (p *AccountPool) GetBySpaceID(spaceID string) *Account {
	spaceID = strings.TrimSpace(spaceID)
	if p == nil || spaceID == "" {
		return nil
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	for _, acc := range p.accounts {
		if acc == nil {
			continue
		}
		acc.mu.RLock()
		match := strings.EqualFold(acc.SpaceID, spaceID)
		acc.mu.RUnlock()
		if match {
			return acc
		}
	}
	return nil
}

// applyPinnedSpace points the account at the pinned workspace. Accounts carry
// one active space; discovery picks it heuristically and a refresh can change
// it back, so the pin is re-applied on every request instead of once at save
// time. It is a no-op when the account already serves that workspace.
func applyPinnedSpace(acc *Account, spaceID, spaceName, spaceViewID string) {
	spaceID = strings.TrimSpace(spaceID)
	if acc == nil || spaceID == "" {
		return
	}
	acc.mu.Lock()
	changed := !strings.EqualFold(acc.SpaceID, spaceID)
	if changed {
		acc.SpaceID = spaceID
		if name := strings.TrimSpace(spaceName); name != "" {
			acc.SpaceName = name
		}
		if view := strings.TrimSpace(spaceViewID); view != "" {
			acc.SpaceViewID = view
		}
	}
	email := acc.UserEmail
	acc.mu.Unlock()
	if changed {
		log.Printf("[api] pinned workspace applied: %s now serves %s", email, describeSpace(spaceName, spaceID))
	}
}

// resolvePinnedAccount finds the account that can reach the pinned workspace:
// preferably the one already serving it, otherwise the recorded owner.
func resolvePinnedAccount(pool *AccountPool, spaceID, email string) *Account {
	if pool == nil {
		return nil
	}
	if acc := pool.GetBySpaceID(spaceID); acc != nil {
		return acc
	}
	if strings.TrimSpace(email) != "" {
		return pool.GetByEmail(email)
	}
	return nil
}

// pinnedAPIAccount returns the account an inference attempt must use, already
// switched to the pinned workspace, or nil when the pool should decide.
// exclude carries the accounts already tried in this request, so a failing pin
// degrades into normal failover instead of retrying a dead account forever.
func pinnedAPIAccount(pool *AccountPool, exclude map[*Account]bool) *Account {
	mode, email := APIRouting()
	if pool == nil || mode != APIRoutingPinned {
		return nil
	}
	spaceID, spaceName, spaceViewID := APIRoutingSpace()
	if spaceID == "" && email == "" {
		return nil
	}
	acc := resolvePinnedAccount(pool, spaceID, email)
	if acc == nil {
		return nil
	}
	if exclude != nil && exclude[acc] {
		return nil
	}
	applyPinnedSpace(acc, spaceID, spaceName, spaceViewID)
	return acc
}
