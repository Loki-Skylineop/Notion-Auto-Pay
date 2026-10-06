package proxy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func setupExclusions(t *testing.T) string {
	t.Helper()
	oldStore, oldCfg := workspaceExclusions.Load(), AppConfig
	oldDiscover, oldPay := discoverRemainingWorkspaces, activeWorkspaceAutoPay.Load()
	t.Cleanup(func() {
		workspaceExclusions.Store(oldStore)
		AppConfig = oldCfg
		discoverRemainingWorkspaces = oldDiscover
		activeWorkspaceAutoPay.Store(oldPay)
	})
	activeWorkspaceAutoPay.Store(nil)
	dir := filepath.Join(t.TempDir(), "accounts")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := ConfigureWorkspaceExclusions(dir); err != nil {
		t.Fatal(err)
	}
	AppConfig = &Config{}
	AppConfig.Server.AccountsDir = dir
	return dir
}
func TestWorkspaceExclusionsSurviveRestartWithoutCredentials(t *testing.T) {
	dir := setupExclusions(t)
	if err := excludeWorkspace("deleted-space"); err != nil {
		t.Fatal(err)
	}
	if err := excludeAccountToken("private-test-token"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(workspaceExclusions.Load().path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "private-test-token") {
		t.Fatal("stored raw credential")
	}
	if err := ConfigureWorkspaceExclusions(dir); err != nil {
		t.Fatal(err)
	}
	if !workspaceIsExcluded("deleted-space") || !accountTokenIsExcluded("private-test-token") {
		t.Fatal("exclusions lost after reload")
	}
	if _, err := DiscoverWorkspacesFromToken("private-test-token"); err == nil {
		t.Fatal("removed token reached discovery")
	}
}
func TestPermanentRemovalDeletesDuplicatesAndStaleSavesCannotRestore(t *testing.T) {
	dir := setupExclusions(t)
	pool := NewAccountPool()
	acc := &Account{TokenV2: "test-token", UserID: "user", UserEmail: "case@example.invalid", SpaceID: "space"}
	path, err := SaveAccountToFile(acc, dir)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, path))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "duplicate.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	pool.AddAccount(acc)
	pool.mu.Lock()
	pool.accounts = append(pool.accounts, acc)
	pool.mu.Unlock()
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); pool.SaveAccounts(dir) }()
	}
	if err := deleteAccountByEmail(pool, dir, "CASE@EXAMPLE.INVALID"); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	pool.SaveAccounts(dir)
	if err := saveAccountFile(dir, acc); err == nil {
		t.Fatal("stale save unexpectedly succeeded")
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 0 {
		t.Fatalf("records restored: %v", files)
	}
	if len(pool.accounts) != 0 {
		t.Fatal("duplicate pool entry survived")
	}
	if _, err := SaveAccountToFile(acc, dir); err == nil {
		t.Fatal("removed credentials could be imported again")
	}
}
func TestExcludedPrimaryRepointsWithoutRemovingOtherSpaces(t *testing.T) {
	dir := setupExclusions(t)
	pool := NewAccountPool()
	acc := &Account{TokenV2: "keep-token", UserID: "user", UserEmail: "keep@example.invalid", SpaceID: "deleted", SpaceName: "Old name"}
	filename, err := SaveAccountToFile(acc, dir)
	if err != nil {
		t.Fatal(err)
	}
	pool.AddAccount(acc)
	discoverRemainingWorkspaces = func(string) (*AccountWorkspaces, error) {
		return &AccountWorkspaces{Spaces: []WorkspaceInfo{{SpaceID: "remaining", Name: "Keep", PlanType: "free"}}}, nil
	}
	if err := excludeWorkspace("deleted"); err != nil {
		t.Fatal(err)
	}
	pool.forgetPrimaryWorkspace("deleted")
	if acc.SpaceID != "remaining" || len(pool.accounts) != 1 {
		t.Fatal("remaining workspace lost")
	}
	raw, err := os.ReadFile(filepath.Join(dir, filename))
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]interface{}
	if json.Unmarshal(raw, &record) != nil {
		t.Fatal("bad account file")
	}
	if record["space_id"] != "remaining" || record["space_name"] != "Keep" {
		t.Fatal("deleted primary still persisted")
	}
	reloaded := NewAccountPool()
	if err := reloaded.LoadFromDir(dir); err != nil {
		t.Fatal(err)
	}
	if len(reloaded.accounts) != 1 || reloaded.accounts[0].SpaceID != "remaining" {
		t.Fatal("restart restored deleted primary")
	}
}
func TestDeletingLastWorkspaceRemovesAccount(t *testing.T) {
	dir := setupExclusions(t)
	pool := NewAccountPool()
	acc := &Account{TokenV2: "last-token", UserID: "user", UserEmail: "last@example.invalid", SpaceID: "last"}
	if _, err := SaveAccountToFile(acc, dir); err != nil {
		t.Fatal(err)
	}
	pool.AddAccount(acc)
	discoverRemainingWorkspaces = func(string) (*AccountWorkspaces, error) { return &AccountWorkspaces{Spaces: []WorkspaceInfo{}}, nil }
	if err := excludeWorkspace("last"); err != nil {
		t.Fatal(err)
	}
	pool.forgetPrimaryWorkspace("last")
	files, _ := os.ReadDir(dir)
	if len(files) != 0 || len(pool.accounts) != 0 {
		t.Fatal("empty account retained")
	}
}
func TestExclusionWriteFailureDoesNotPretendSuccess(t *testing.T) {
	setupExclusions(t)
	store := workspaceExclusions.Load()
	store.path = filepath.Join(t.TempDir(), "directory")
	if err := os.Mkdir(store.path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := excludeWorkspace("not-persisted"); err == nil {
		t.Fatal("write failure not reported")
	}
	if workspaceIsExcluded("not-persisted") {
		t.Fatal("failed persistence marked successful")
	}
}
func TestWorkspaceExclusionPurgesAutopayState(t *testing.T) {
	dir := setupExclusions(t)
	m := NewAutoPayManager(NewAccountPool(), dir, "")
	SetWorkspaceAutoPay(m)
	m.cfg.Spaces["deleted"] = true
	m.cfg.SpacePlans["deleted"] = "plan"
	m.cfg.Paid["deleted"] = 1
	m.cfg.Spaces["kept"] = true
	if err := excludeWorkspace("deleted"); err != nil {
		t.Fatal(err)
	}
	if _, ok := m.cfg.Spaces["deleted"]; ok {
		t.Fatal("deleted auto flag retained")
	}
	if len(m.cfg.SpacePlans) > 0 || len(m.cfg.Paid) > 0 || !m.cfg.Spaces["kept"] {
		t.Fatal("autopay cleanup corrupted state")
	}
}
