package proxy

// Multi-user access for the dashboard.
//
// The stock build had a single admin password: whoever knew it saw the whole
// account pool. This file adds named logins persisted in users.json:
//
//   - each user has their own password, stored as a bcrypt hash;
//   - only an admin creates users, there is no self-registration;
//   - a user only sees the Notion accounts assigned to them plus the single
//     workspaces (spaces) an admin granted;
//   - two roles: "admin" (whole dashboard) and "user" (chat + read-only pay tab).
//
// File layout (0600, atomic replace on every write):
//
//	{
//	  "version": 1,
//	  "users": [{"username": "ivan", "role": "user", "password_hash": "$2a$..."}]
//	}

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Roles understood by the dashboard.
const (
	RoleAdmin = "admin"
	RoleUser  = "user"
)

// DefaultUsersFile is where the registry lives when nothing else is configured.
const DefaultUsersFile = "users.json"

var (
	ErrUserNotFound   = errors.New("user not found")
	ErrUserExists     = errors.New("user already exists")
	ErrBadCredentials = errors.New("invalid username or password")
	ErrUserDisabled   = errors.New("user is disabled")
	ErrLastAdmin      = errors.New("cannot remove or demote the last admin")
)

// UserSpace is one workspace an admin granted to a user. SpaceID is what the
// chat/billing endpoints authorize against; AccountEmail records which pool
// account owns the token that space belongs to, so the UI can show the pair.
type UserSpace struct {
	AccountEmail string `json:"account_email,omitempty"`
	SpaceID      string `json:"space_id"`
	SpaceName    string `json:"space_name,omitempty"`
}

// User is a single dashboard login.
type User struct {
	Username     string      `json:"username"`
	DisplayName  string      `json:"display_name,omitempty"`
	Role         string      `json:"role"`
	PasswordHash string      `json:"password_hash"`
	Accounts     []string    `json:"accounts"`
	Spaces       []UserSpace `json:"spaces"`
	Disabled     bool        `json:"disabled,omitempty"`
	CreatedAt    time.Time   `json:"created_at"`
	UpdatedAt    time.Time   `json:"updated_at"`
	LastLoginAt  *time.Time  `json:"last_login_at,omitempty"`
}

// UserView is what the admin API returns: everything except the hash, which
// never leaves the server.
type UserView struct {
	Username    string      `json:"username"`
	DisplayName string      `json:"display_name,omitempty"`
	Role        string      `json:"role"`
	Accounts    []string    `json:"accounts"`
	Spaces      []UserSpace `json:"spaces"`
	Disabled    bool        `json:"disabled"`
	CreatedAt   time.Time   `json:"created_at"`
	UpdatedAt   time.Time   `json:"updated_at"`
	LastLoginAt *time.Time  `json:"last_login_at,omitempty"`
}

func (u *User) clone() *User {
	if u == nil {
		return nil
	}
	cp := *u
	cp.Accounts = append([]string(nil), u.Accounts...)
	cp.Spaces = append([]UserSpace(nil), u.Spaces...)
	return &cp
}

func (u *User) view() UserView {
	v := UserView{
		Username:    u.Username,
		DisplayName: u.DisplayName,
		Role:        u.Role,
		Accounts:    append([]string{}, u.Accounts...),
		Spaces:      append([]UserSpace{}, u.Spaces...),
		Disabled:    u.Disabled,
		CreatedAt:   u.CreatedAt,
		UpdatedAt:   u.UpdatedAt,
		LastLoginAt: u.LastLoginAt,
	}
	return v
}

// IsAdmin reports whether the user has full dashboard rights.
func (u *User) IsAdmin() bool { return u != nil && u.Role == RoleAdmin }

// --- Store ---

// UserStore is the users.json-backed registry. Every exported method is safe
// for concurrent use and persists immediately.
type UserStore struct {
	mu    sync.RWMutex
	path  string
	users map[string]*User // key: normalized username
}

type usersFile struct {
	Version int     `json:"version"`
	Users   []*User `json:"users"`
}

// NormalizeUsername lowercases and trims a login so "Ivan " and "ivan" are
// the same account.
func NormalizeUsername(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

func normalizeEmail(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

func normalizeRole(role string) string {
	if strings.EqualFold(strings.TrimSpace(role), RoleAdmin) {
		return RoleAdmin
	}
	return RoleUser
}

// ValidateUsername keeps logins URL- and log-friendly.
func ValidateUsername(s string) error {
	u := NormalizeUsername(s)
	if len(u) < 3 || len(u) > 32 {
		return errors.New("логин должен быть от 3 до 32 символов")
	}
	for _, r := range u {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-'
		if !ok {
			return errors.New("логин может содержать только a-z, 0-9, точку, дефис и подчёркивание")
		}
	}
	return nil
}

// ValidatePassword enforces a small floor and bcrypt's hard 72-byte ceiling
// (bcrypt silently truncates anything longer, which would be a nasty surprise).
func ValidatePassword(p string) error {
	if len(p) < 6 {
		return errors.New("пароль должен быть не короче 6 символов")
	}
	if len(p) > 72 {
		return errors.New("пароль должен быть не длиннее 72 байт (ограничение bcrypt)")
	}
	return nil
}

func hashPassword(p string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(p), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// LoadUserStore reads users.json, tolerating a missing or empty file so a
// fresh install starts with zero users.
func LoadUserStore(path string) (*UserStore, error) {
	if strings.TrimSpace(path) == "" {
		path = DefaultUsersFile
	}
	s := &UserStore{path: path, users: map[string]*User{}}

	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			log.Printf("[users] %s not found — starting with an empty user list", path)
			return s, nil
		}
		return nil, err
	}
	if strings.TrimSpace(string(raw)) == "" {
		return s, nil
	}

	var f usersFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	for _, u := range f.Users {
		if u == nil {
			continue
		}
		key := NormalizeUsername(u.Username)
		if key == "" {
			continue
		}
		u.Username = key
		u.Role = normalizeRole(u.Role)
		if u.Accounts == nil {
			u.Accounts = []string{}
		}
		if u.Spaces == nil {
			u.Spaces = []UserSpace{}
		}
		s.users[key] = u
	}
	log.Printf("[users] loaded %d user(s) from %s", len(s.users), path)
	return s, nil
}

// Path is where this store persists.
func (s *UserStore) Path() string { return s.path }

// saveLocked writes the whole file atomically. Callers must hold s.mu.
func (s *UserStore) saveLocked() error {
	list := make([]*User, 0, len(s.users))
	for _, u := range s.users {
		list = append(list, u)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Username < list[j].Username })

	buf, err := json.MarshalIndent(usersFile{Version: 1, Users: list}, "", "  ")
	if err != nil {
		return err
	}
	buf = append(buf, '\n')

	if dir := filepath.Dir(s.path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, buf, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// Count is the number of registered users.
func (s *UserStore) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.users)
}

// HasUsers reports whether any login exists. Used to decide that the
// dashboard needs an auth prompt even without admin_password in config.yaml.
func (s *UserStore) HasUsers() bool { return s.Count() > 0 }

// List returns all users (hash stripped) sorted by username.
func (s *UserStore) List() []UserView {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]UserView, 0, len(s.users))
	for _, u := range s.users {
		out = append(out, u.view())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Username < out[j].Username })
	return out
}

// Get returns a copy of one user.
func (s *UserStore) Get(username string) (*User, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.users[NormalizeUsername(username)]
	if !ok {
		return nil, false
	}
	return u.clone(), true
}

// View returns one user in API shape.
func (s *UserStore) View(username string) (UserView, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.users[NormalizeUsername(username)]
	if !ok {
		return UserView{}, false
	}
	return u.view(), true
}

// adminCountLocked counts enabled admins. Callers must hold s.mu.
func (s *UserStore) adminCountLocked(excluding string) int {
	n := 0
	for key, u := range s.users {
		if key == excluding {
			continue
		}
		if u.Role == RoleAdmin && !u.Disabled {
			n++
		}
	}
	return n
}

// Create adds a new login. Passwords are hashed with bcrypt before they touch
// the disk; the plaintext is never stored or logged.
func (s *UserStore) Create(username, password, role, displayName string) (UserView, error) {
	if err := ValidateUsername(username); err != nil {
		return UserView{}, err
	}
	if err := ValidatePassword(password); err != nil {
		return UserView{}, err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return UserView{}, err
	}

	key := NormalizeUsername(username)
	now := time.Now()

	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.users[key]; exists {
		return UserView{}, ErrUserExists
	}
	u := &User{
		Username:     key,
		DisplayName:  strings.TrimSpace(displayName),
		Role:         normalizeRole(role),
		PasswordHash: hash,
		Accounts:     []string{},
		Spaces:       []UserSpace{},
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	s.users[key] = u
	if err := s.saveLocked(); err != nil {
		delete(s.users, key)
		return UserView{}, err
	}
	log.Printf("[users] created %q (role=%s)", key, u.Role)
	return u.view(), nil
}

// SetPassword replaces one user's password.
func (s *UserStore) SetPassword(username, password string) error {
	if err := ValidatePassword(password); err != nil {
		return err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	key := NormalizeUsername(username)

	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[key]
	if !ok {
		return ErrUserNotFound
	}
	prev := u.PasswordHash
	u.PasswordHash = hash
	u.UpdatedAt = time.Now()
	if err := s.saveLocked(); err != nil {
		u.PasswordHash = prev
		return err
	}
	log.Printf("[users] password changed for %q", key)
	return nil
}

// UserPatch carries optional field updates; nil means "leave as is".
type UserPatch struct {
	Role        *string
	DisplayName *string
	Disabled    *bool
	Accounts    *[]string
	Spaces      *[]UserSpace
}

// Update applies a patch. Assigning accounts is exclusive: an account handed
// to one user is taken away from everybody else, which is what keeps each
// user's space actually separate.
func (s *UserStore) Update(username string, patch UserPatch) (UserView, error) {
	key := NormalizeUsername(username)

	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[key]
	if !ok {
		return UserView{}, ErrUserNotFound
	}
	backup := u.clone()

	if patch.Role != nil {
		role := normalizeRole(*patch.Role)
		if u.Role == RoleAdmin && role != RoleAdmin && s.adminCountLocked(key) == 0 {
			return UserView{}, ErrLastAdmin
		}
		u.Role = role
	}
	if patch.DisplayName != nil {
		u.DisplayName = strings.TrimSpace(*patch.DisplayName)
	}
	if patch.Disabled != nil {
		if *patch.Disabled && u.Role == RoleAdmin && s.adminCountLocked(key) == 0 {
			return UserView{}, ErrLastAdmin
		}
		u.Disabled = *patch.Disabled
	}
	if patch.Accounts != nil {
		emails := make([]string, 0, len(*patch.Accounts))
		seen := map[string]bool{}
		for _, e := range *patch.Accounts {
			n := normalizeEmail(e)
			if n == "" || seen[n] {
				continue
			}
			seen[n] = true
			emails = append(emails, n)
		}
		sort.Strings(emails)
		u.Accounts = emails
		// Exclusive ownership: drop these emails from every other user.
		for otherKey, other := range s.users {
			if otherKey == key || len(other.Accounts) == 0 {
				continue
			}
			kept := make([]string, 0, len(other.Accounts))
			for _, e := range other.Accounts {
				if !seen[normalizeEmail(e)] {
					kept = append(kept, e)
				}
			}
			if len(kept) != len(other.Accounts) {
				other.Accounts = kept
				other.UpdatedAt = time.Now()
			}
		}
	}
	if patch.Spaces != nil {
		spaces := make([]UserSpace, 0, len(*patch.Spaces))
		seen := map[string]bool{}
		for _, sp := range *patch.Spaces {
			id := strings.TrimSpace(sp.SpaceID)
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			spaces = append(spaces, UserSpace{
				AccountEmail: normalizeEmail(sp.AccountEmail),
				SpaceID:      id,
				SpaceName:    strings.TrimSpace(sp.SpaceName),
			})
		}
		u.Spaces = spaces
	}
	u.UpdatedAt = time.Now()

	if err := s.saveLocked(); err != nil {
		s.users[key] = backup
		return UserView{}, err
	}
	return u.view(), nil
}

// Delete removes a login, refusing to strand the dashboard without an admin.
func (s *UserStore) Delete(username string) error {
	key := NormalizeUsername(username)

	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[key]
	if !ok {
		return ErrUserNotFound
	}
	if u.Role == RoleAdmin && s.adminCountLocked(key) == 0 {
		return ErrLastAdmin
	}
	delete(s.users, key)
	if err := s.saveLocked(); err != nil {
		s.users[key] = u
		return err
	}
	log.Printf("[users] deleted %q", key)
	return nil
}

// Authenticate verifies a password and bumps last_login_at on success.
func (s *UserStore) Authenticate(username, password string) (*User, error) {
	key := NormalizeUsername(username)

	s.mu.RLock()
	u := s.users[key]
	var hash string
	var disabled bool
	if u != nil {
		hash = u.PasswordHash
		disabled = u.Disabled
	}
	s.mu.RUnlock()

	if u == nil {
		return nil, ErrUserNotFound
	}
	if disabled {
		return nil, ErrUserDisabled
	}
	if hash == "" || bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return nil, ErrBadCredentials
	}

	now := time.Now()
	s.mu.Lock()
	var out *User
	if cur := s.users[key]; cur != nil {
		cur.LastLoginAt = &now
		_ = s.saveLocked()
		out = cur.clone()
	}
	s.mu.Unlock()
	if out == nil {
		return nil, ErrUserNotFound
	}
	return out, nil
}

// AllowedAccounts is the set of pool account emails a user may use.
func (s *UserStore) AllowedAccounts(username string) map[string]bool {
	out := map[string]bool{}
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.users[NormalizeUsername(username)]
	if !ok {
		return out
	}
	for _, e := range u.Accounts {
		if n := normalizeEmail(e); n != "" {
			out[n] = true
		}
	}
	return out
}

// AllowedSpaces is the set of space IDs granted to a user directly by an admin.
func (s *UserStore) AllowedSpaces(username string) map[string]bool {
	out := map[string]bool{}
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.users[NormalizeUsername(username)]
	if !ok {
		return out
	}
	for _, sp := range u.Spaces {
		if id := strings.TrimSpace(sp.SpaceID); id != "" {
			out[id] = true
		}
	}
	return out
}

// GrantedSpaceEmails maps every granted space to the account email that owns
// it, so a user can chat in a space of an account that is not theirs.
func (s *UserStore) GrantedSpaceEmails(username string) map[string]string {
	out := map[string]string{}
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.users[NormalizeUsername(username)]
	if !ok {
		return out
	}
	for _, sp := range u.Spaces {
		id := strings.TrimSpace(sp.SpaceID)
		if id == "" {
			continue
		}
		out[id] = normalizeEmail(sp.AccountEmail)
	}
	return out
}
