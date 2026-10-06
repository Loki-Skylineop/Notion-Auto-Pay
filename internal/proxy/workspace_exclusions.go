package proxy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
)

// Only irreversible exclusion identifiers survive restarts. No workspace records,
// names, email addresses, balances or credentials are retained here.
type workspaceExclusionStore struct {
	mu     sync.RWMutex
	path   string
	Spaces map[string]bool `json:"spaces"`
	Tokens map[string]bool `json:"account_token_hashes"`
}

var workspaceExclusions atomic.Pointer[workspaceExclusionStore]

func ConfigureWorkspaceExclusions(accountsDir string) error {
	s := &workspaceExclusionStore{path: filepath.Join(filepath.Dir(filepath.Clean(accountsDir)), "workspace-exclusions.json"), Spaces: map[string]bool{}, Tokens: map[string]bool{}}
	data, err := os.ReadFile(s.path)
	if err == nil {
		if err = json.Unmarshal(data, s); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if s.Spaces == nil {
		s.Spaces = map[string]bool{}
	}
	if s.Tokens == nil {
		s.Tokens = map[string]bool{}
	}
	workspaceExclusions.Store(s)
	return nil
}
func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return hex.EncodeToString(sum[:])
}
func workspaceIsExcluded(id string) bool {
	s := workspaceExclusions.Load()
	if s == nil {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.Spaces[id]
}
func accountTokenIsExcluded(token string) bool {
	s := workspaceExclusions.Load()
	if s == nil || token == "" {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.Tokens[tokenHash(token)]
}

var activeWorkspaceAutoPay atomic.Pointer[AutoPayManager]

func SetWorkspaceAutoPay(manager *AutoPayManager) {
	activeWorkspaceAutoPay.Store(manager)
	if manager != nil {
		manager.mu.Lock()
		manager.saveLocked()
		manager.mu.Unlock()
	}
}
func excludeWorkspace(id string) error {
	if err := persistExclusion(id, false); err != nil {
		return err
	}
	if manager := activeWorkspaceAutoPay.Load(); manager != nil {
		manager.mu.Lock()
		delete(manager.cfg.Spaces, id)
		delete(manager.cfg.SpacePlans, id)
		delete(manager.cfg.Paid, id)
		manager.saveLocked()
		manager.mu.Unlock()
	}
	return nil
}
func excludeAccountToken(token string) error {
	if token == "" {
		return nil
	}
	return persistExclusion(tokenHash(token), true)
}
func persistExclusion(id string, token bool) error {
	s := workspaceExclusions.Load()
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entries := s.Spaces
	if token {
		entries = s.Tokens
	}
	if entries[id] {
		return nil
	}
	entries[id] = true
	data, err := json.MarshalIndent(s, "", "  ")
	if err == nil {
		err = os.MkdirAll(filepath.Dir(s.path), 0700)
	}
	if err == nil {
		err = os.WriteFile(s.path+".tmp", data, 0600)
	}
	if err == nil {
		err = os.Rename(s.path+".tmp", s.path)
	}
	if err != nil {
		delete(entries, id)
		return fmt.Errorf("persist exclusions: %w", err)
	}
	return nil
}

var discoverRemainingWorkspaces = DiscoverWorkspacesFromToken

// Repoint the primary account workspace without deleting unrelated spaces.
func (p *AccountPool) forgetPrimaryWorkspace(id string) {
	p.mu.RLock()
	var affected []*Account
	for _, acc := range p.accounts {
		if acc.SpaceID == id {
			affected = append(affected, acc)
		}
	}
	p.mu.RUnlock()
	if AppConfig == nil {
		return
	}
	dir := AppConfig.Server.AccountsDir
	for _, acc := range affected {
		fresh, err := discoverRemainingWorkspaces(acc.TokenV2)
		if err != nil {
			log.Printf("[workspace] primary excluded; remaining discovery failed: %v", err)
			p.repointPrimaryWorkspace(acc, WorkspaceInfo{})
			continue
		}
		if len(fresh.Spaces) == 0 {
			if err := deleteAccountByEmail(p, dir, acc.UserEmail); err != nil {
				log.Printf("[workspace] empty account cleanup failed: %v", err)
			}
			continue
		}
		space := fresh.Spaces[0]
		p.repointPrimaryWorkspace(acc, space)
	}
}

func (p *AccountPool) repointPrimaryWorkspace(acc *Account, space WorkspaceInfo) {
	if AppConfig == nil {
		return
	}
	dir := AppConfig.Server.AccountsDir
	accountFilesMu.Lock()
	p.mu.Lock()
	present := false
	for _, current := range p.accounts {
		if current == acc {
			present = true
		}
	}
	if present {
		acc.mu.Lock()
		acc.SpaceID, acc.SpaceName, acc.SpaceViewID, acc.PlanType = space.SpaceID, space.Name, space.SpaceViewID, space.PlanType
		acc.Models, acc.QuotaInfo, acc.QuotaCheckedAt, acc.QuotaExhaustedAt = nil, nil, nil, nil
		acc.PermanentlyExhausted = false
		acc.mu.Unlock()
	}
	p.mu.Unlock()
	if present {
		entries, readErr := os.ReadDir(dir)
		if readErr == nil {
			for _, entry := range entries {
				if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
					continue
				}
				path := filepath.Join(dir, entry.Name())
				data, err := os.ReadFile(path)
				if err != nil {
					continue
				}
				var raw map[string]interface{}
				if json.Unmarshal(data, &raw) != nil {
					continue
				}
				email, _ := raw["user_email"].(string)
				if !strings.EqualFold(email, acc.UserEmail) {
					continue
				}
				raw["space_id"], raw["space_name"], raw["space_view_id"], raw["plan_type"] = space.SpaceID, space.Name, space.SpaceViewID, space.PlanType
				delete(raw, "quota_info")
				delete(raw, "quota_checked_at")
				delete(raw, "quota_exhausted_at")
				delete(raw, "available_models")
				out, err := json.MarshalIndent(raw, "", "  ")
				if err == nil {
					err = os.WriteFile(path, out, 0600)
				}
				if err != nil {
					log.Printf("[workspace] primary persistence failed: %v", err)
				}
			}
		}
	}
	accountFilesMu.Unlock()
}
