package proxy

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
)

// HandleListWorkspaces discovers workspaces for every account currently in the
// pool and returns them as a JSON array of AccountWorkspaces.
//
// The dashboard uses this to hydrate its workspace list straight from the
// server — e.g. in a fresh incognito window where the browser's localStorage
// cache (nmp_discovered_workspaces) is empty — instead of relying only on the
// per-browser cache. The response shape matches what the "add account" flow
// stores locally, so the frontend can merge the two seamlessly.
func HandleListWorkspaces(pool *AccountPool, auth *DashboardAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if auth.HasAdminPassword() && !auth.ValidateSession(r) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}

		// Snapshot the unique account tokens under the read lock so discovery
		// (which makes network calls) runs without holding the pool mutex.
		pool.mu.RLock()
		tokens := make([]string, 0, len(pool.accounts))
		seen := make(map[string]bool)
		for _, acc := range pool.accounts {
			t := strings.TrimSpace(acc.TokenV2)
			if t == "" || seen[t] {
				continue
			}
			seen[t] = true
			tokens = append(tokens, t)
		}
		pool.mu.RUnlock()

		// Discover each account's workspaces concurrently. Index-addressed
		// writes keep this data-race free without an extra mutex.
		results := make([]*AccountWorkspaces, len(tokens))
		var wg sync.WaitGroup
		for i, t := range tokens {
			wg.Add(1)
			go func(idx int, token string) {
				defer wg.Done()
				aw, err := DiscoverWorkspacesFromToken(token)
				if err != nil {
					log.Printf("[workspace] list discovery failed: %v", err)
					return
				}
				results[idx] = aw
			}(i, t)
		}
		wg.Wait()

		// Drop accounts that failed discovery so the dashboard only renders the
		// ones we could resolve. Always emit a (possibly empty) JSON array.
		out := make([]*AccountWorkspaces, 0, len(results))
		for _, aw := range results {
			if aw == nil || accountTokenIsExcluded(aw.TokenV2) {
				continue
			}
			visible := aw.Spaces[:0]
			for _, space := range aw.Spaces {
				if !workspaceIsExcluded(space.SpaceID) {
					visible = append(visible, space)
				}
			}
			aw.Spaces = visible
			pool.mu.RLock()
			var current *Account
			for _, account := range pool.accounts {
				if account.TokenV2 == aw.TokenV2 {
					current = account
					break
				}
			}
			needsPrimary := current != nil && (current.SpaceID == "" || workspaceIsExcluded(current.SpaceID))
			pool.mu.RUnlock()
			if current == nil {
				continue
			}
			if needsPrimary && len(visible) > 0 {
				pool.repointPrimaryWorkspace(current, visible[0])
			}
			out = append(out, aw)
		}

		if err := json.NewEncoder(w).Encode(out); err != nil {
			log.Printf("[workspace] encode list failed: %v", err)
		}
	}
}
