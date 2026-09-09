package proxy

import "testing"

// The discovery endpoint asks Notion for every workspace behind a token, so the
// answer must be trimmed before a non-admin sees it. These tests pin that down.

func sampleDiscovered() *AccountWorkspaces {
	return &AccountWorkspaces{
		UserID:    "user-1",
		UserEmail: "owner@example.com",
		TokenV2:   "tok",
		Spaces: []WorkspaceInfo{
			{SpaceID: " granted-space ", Name: "Granted"},
			{SpaceID: "foreign-space", Name: "Foreign"},
			{SpaceID: "other-space", Name: "Other"},
		},
	}
}

func spaceIDs(acct *AccountWorkspaces) []string {
	out := make([]string, 0, len(acct.Spaces))
	for _, sp := range acct.Spaces {
		out = append(out, sp.SpaceID)
	}
	return out
}

func TestFilterAccountSpacesOwnedAccountKeepsEverything(t *testing.T) {
	acct := sampleDiscovered()
	a := allowance{
		emails: map[string]bool{"owner@example.com": true},
		spaces: map[string]bool{},
	}
	filterAccountSpaces(acct, a)
	if len(acct.Spaces) != 3 {
		t.Fatalf("owned account should keep all spaces, got %v", spaceIDs(acct))
	}
}

func TestFilterAccountSpacesKeepsOnlyGrantedSpace(t *testing.T) {
	acct := sampleDiscovered()
	a := allowance{
		emails:       map[string]bool{},
		spaces:       map[string]bool{"granted-space": true},
		grantedMails: map[string]bool{"owner@example.com": true},
	}
	filterAccountSpaces(acct, a)
	if len(acct.Spaces) != 1 || acct.Spaces[0].Name != "Granted" {
		t.Fatalf("expected only the granted space, got %v", spaceIDs(acct))
	}
}

func TestFilterAccountSpacesDropsAllWhenNothingGranted(t *testing.T) {
	acct := sampleDiscovered()
	a := allowance{emails: map[string]bool{}, spaces: map[string]bool{}}
	filterAccountSpaces(acct, a)
	if len(acct.Spaces) != 0 {
		t.Fatalf("expected no spaces, got %v", spaceIDs(acct))
	}
}

func TestFilterAccountSpacesNilAccount(t *testing.T) {
	filterAccountSpaces(nil, allowance{})
}
