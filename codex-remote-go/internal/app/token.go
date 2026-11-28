package app

import (
	"bytes"
	"compress/flate"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Claims are the self-describing launch identity. They travel in the TUI's
// Authorization header and, via environment/add's authBearerToken, on every
// app-server -> proxy reconnect. A proxy restart therefore loses no routing
// information as long as the TUI is still alive (it replays the header).
type Claims struct {
	V              int               `json:"v"`
	ConfigPath     string            `json:"cfg,omitempty"`
	ConfigName     string            `json:"cn,omitempty"`
	Pane           string            `json:"p,omitempty"`
	EnvID          string            `json:"eid,omitempty"`
	RemoteCWD      string            `json:"rc,omitempty"`
	RemoteHome     string            `json:"rh,omitempty"`
	LocalHome      string            `json:"lh,omitempty"`
	WinCWD         string            `json:"wc,omitempty"`
	WinPath        string            `json:"wp,omitempty"`
	BashExe        string            `json:"bx,omitempty"`
	Env            map[string]string `json:"e,omitempty"`
	LocalMatch     []string          `json:"lm,omitempty"`
	LocalWhitelist []string          `json:"lw,omitempty"`
	RemoteOverride []string          `json:"ro,omitempty"`
	Yolo           *bool             `json:"y,omitempty"`
	IssuedAt       int64             `json:"t,omitempty"`
	LauncherPID    int               `json:"lp,omitempty"`
}

const (
	tokenPrefix       = "cr1."
	tokenPrefixPacked = "cr1z."
)

type TokenKey struct {
	secret []byte
	path   string
	mu     sync.Mutex
}

func LoadOrCreateTokenKey(runDir string) (*TokenKey, error) {
	path := os.Getenv("CODEX_REMOTE_TOKEN_KEY_FILE")
	if path == "" {
		path = filepath.Join(runDir, "token.key")
	}
	if data, err := os.ReadFile(path); err == nil && len(data) >= 16 {
		return &TokenKey{secret: data, path: path}, nil
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, secret, 0o600); err != nil {
		return nil, err
	}
	return &TokenKey{secret: secret, path: path}, nil
}

// LoadOrCreateControlKey gates the local /control endpoints. Loopback-only
// plus this key keeps "stop" from being a generic local DoS.
func LoadOrCreateControlKey(runDir string) (string, error) {
	path := filepath.Join(runDir, "control.key")
	if data, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(data))) >= 16 {
		return strings.TrimSpace(string(data)), nil
	}
	secret := RandomHex(24)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(secret), 0o600); err != nil {
		return "", err
	}
	return secret, nil
}

func NewTokenKeyForTests(secret []byte) *TokenKey {
	return &TokenKey{secret: append([]byte(nil), secret...)}
}

func (k *TokenKey) Encode(c *Claims) (string, error) {
	if c.V == 0 {
		c.V = 1
	}
	payload, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	prefix := tokenPrefix
	// WinPath alone is several KB; compress so the Authorization header stays
	// comfortably inside HTTP header limits.
	if packed, err := deflate(payload); err == nil && len(packed) < len(payload)*3/4 {
		payload = packed
		prefix = tokenPrefixPacked
	}
	mac := hmac.New(sha256.New, k.secret)
	_, _ = mac.Write(payload)
	return prefix +
		base64.RawURLEncoding.EncodeToString(payload) + "." +
		base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func (k *TokenKey) Decode(token string) (*Claims, error) {
	token = strings.TrimSpace(token)
	prefix := tokenPrefix
	packed := false
	switch {
	case strings.HasPrefix(token, tokenPrefixPacked):
		prefix = tokenPrefixPacked
		packed = true
	case strings.HasPrefix(token, tokenPrefix):
	default:
		return nil, errors.New("not a cr1 token")
	}
	parts := strings.Split(token[len(prefix):], ".")
	if len(parts) != 2 {
		return nil, errors.New("malformed token")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, fmt.Errorf("token payload: %w", err)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("token signature: %w", err)
	}
	mac := hmac.New(sha256.New, k.secret)
	_, _ = mac.Write(payload)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return nil, errors.New("token signature mismatch")
	}
	if packed {
		if payload, err = inflate(payload); err != nil {
			return nil, fmt.Errorf("token payload: %w", err)
		}
	}
	var c Claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return nil, fmt.Errorf("token claims: %w", err)
	}
	return &c, nil
}

func deflate(b []byte) ([]byte, error) {
	var buf bytes.Buffer
	w, err := flate.NewWriter(&buf, flate.BestCompression)
	if err != nil {
		return nil, err
	}
	if _, err := w.Write(b); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func inflate(b []byte) ([]byte, error) {
	r := flate.NewReader(bytes.NewReader(b))
	defer r.Close()
	return io.ReadAll(io.LimitReader(r, 1<<20))
}

func EnvIDForToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return "cr1-" + hex.EncodeToString(h[:12])
}

// MakeEnvID is stable for one pane in one config, so relaunching a TUI in the
// same shell replaces its environment instead of adding another.
func MakeEnvID(cfg *Config, pane string) string {
	h := sha256.Sum256([]byte(cfg.Key + "|" + pane))
	return "cr1-" + hex.EncodeToString(h[:12])
}

func BearerToken(header string) string {
	header = strings.TrimSpace(header)
	if len(header) >= 7 && strings.EqualFold(header[:7], "bearer ") {
		return strings.TrimSpace(header[7:])
	}
	return header
}

// CaptureEnvSnapshot implements the generalized "the pane's shell environment"
// model: instead of hardcoding HERDR_*, the launcher snapshots variables by
// configured prefixes/includes, or everything when inheritEnv is on.
func CaptureEnvSnapshot(c *Config) map[string]string {
	exclude := map[string]bool{}
	for _, k := range c.Exec.EnvExclude {
		exclude[k] = true
	}
	base := loadBaseEnv()
	out := map[string]string{}
	for _, kv := range os.Environ() {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || exclude[k] {
			continue
		}
		// "The pane's shell environment" is everything this shell has that the
		// shared services were not started with. That covers HERDR_* and any
		// other per-pane variable without hardcoding names.
		take := c.Exec.InheritEnv
		if !take && base != nil {
			old, seen := base[k]
			take = !seen || old != v
		}
		if !take {
			for _, p := range c.Exec.EnvInclude {
				if k == p {
					take = true
					break
				}
			}
		}
		if !take {
			for _, p := range c.Exec.EnvPrefixes {
				if p == "*" || strings.HasPrefix(k, p) {
					take = true
					break
				}
			}
		}
		if take {
			out[k] = v
		}
	}
	for k, v := range c.Exec.Env {
		out[k] = v
	}
	return out
}

func loadBaseEnv() map[string]string {
	path := filepath.Join(RunDir(), "base-env.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var m map[string]string
	if json.Unmarshal(data, &m) != nil {
		return nil
	}
	return m
}

// WriteBaseEnv records the shared services' environment. The launcher does this
// once (with the proxy/setup process), so later panes can diff against it.
func WriteBaseEnv(env map[string]string) error {
	path := filepath.Join(RunDir(), "base-env.json")
	if _, err := os.Stat(path); err == nil {
		return nil // first writer wins
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
