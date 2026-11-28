package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	DefaultAppServerPort        = 19100
	DefaultProxyPort            = 19101
	DefaultTunnelPort           = 19103
	DefaultWinExecServerPort    = 19200
	DefaultRemoteExecServerPort = 19104
)

type SSHConfig struct {
	Host          string `json:"host"`
	User          string `json:"user"`
	Port          int    `json:"port"`
	Password      string `json:"password"`
	KeyPath       string `json:"keyPath"`
	Passphrase    string `json:"passphrase"`
	KnownHosts    string `json:"knownHosts"`
	StrictHostKey bool   `json:"strictHostKey"`
	SocksProxy    string `json:"socksProxy"`
}

type PathsConfig struct {
	VCWD       string `json:"vcwd"`
	RemoteHome string `json:"remoteHome"`
	SocksProxy string `json:"socksProxy"`
}

type CodexConfig struct {
	Exe               string `json:"exe"`
	ExecServerVersion string `json:"execServerVersion"`
	LocalHome         string `json:"localHome"`
	StrictVersion     bool   `json:"strictVersion"`
}

type PortsConfig struct {
	AppServer        int `json:"appServer"`
	Proxy            int `json:"proxy"`
	ProxyCwd         int `json:"proxyCwd"`
	ProxyRoute       int `json:"proxyRoute"`
	Tunnel           int `json:"tunnel"`
	LocalExecServer  int `json:"localExecServer"`
	WinExecServer    int `json:"winExecServer"`
	RemoteExecServer int `json:"remoteExecServer"`
}

type ExecConfig struct {
	LocalMatch       []string          `json:"localMatch"`
	LocalWhitelist   []string          `json:"localWhitelist"`
	RemoteOverride   []string          `json:"remoteOverride"`
	LocalPath        string            `json:"localPath"`
	CanonicalizeHome bool              `json:"canonicalizeHome"`
	HomeAliases      HomeAliases       `json:"homeAliases"`
	EnvPrefixes      []string          `json:"envPrefixes"`
	EnvInclude       []string          `json:"envInclude"`
	EnvExclude       []string          `json:"envExclude"`
	Env              map[string]string `json:"env"`
	InheritEnv       bool              `json:"inheritEnv"`
}

// HomeAliases lists the known spellings of each side's home directory.
// Canonicalization replaces the opposite side's aliases with the target side's
// canonical home (cfg.LocalHome or cfg.RemoteHome), not with a hard-coded
// replacement string.
type HomeAliases struct {
	Local  []string `json:"local,omitempty"`
	Remote []string `json:"remote,omitempty"`
	// Win is accepted for compatibility with configurations written by older
	// builds. Local takes precedence when both are present.
	Win []string `json:"win,omitempty"`
}

func (h HomeAliases) LocalValues() []string {
	if h.Local != nil {
		return h.Local
	}
	return h.Win
}

type SyncConfig struct {
	Enabled   bool     `json:"enabled"`
	Whitelist []string `json:"whitelist"`
	Exclude   []string `json:"exclude"`
}

type ProxyConfig struct {
	IdleGraceSec int  `json:"idleGraceSec"`
	Debug        bool `json:"debug"`
}

type RemoteConfig struct {
	PrivateHome              string `json:"privateHome"`
	InstallRoot              string `json:"installRoot"`
	RestartOnVersionMismatch bool   `json:"restartOnVersionMismatch"`
}

type Config struct {
	Transport    string       `json:"transport"`
	Name         string       `json:"name"`
	SSH          SSHConfig    `json:"ssh"`
	Paths        PathsConfig  `json:"paths"`
	Codex        CodexConfig  `json:"codex"`
	Ports        PortsConfig  `json:"ports"`
	Exec         ExecConfig   `json:"exec"`
	Sync         SyncConfig   `json:"sync"`
	Yolo         bool         `json:"yolo"`
	Keepalive    int          `json:"keepalive"`
	ReadyTimeout int          `json:"readyTimeout"`
	Proxy        ProxyConfig  `json:"proxy"`
	Remote       RemoteConfig `json:"remote"`

	Path string `json:"-"`
	Key  string `json:"-"`
}

func defaultConfig() Config {
	home, _ := os.UserHomeDir()
	return Config{
		Transport: "ssh",
		Name:      "wsl",
		SSH: SSHConfig{
			Host: "127.0.0.1",
			User: "root",
			Port: 22,
		},
		Paths: PathsConfig{VCWD: "/root"},
		Ports: PortsConfig{
			AppServer:        DefaultAppServerPort,
			Proxy:            DefaultProxyPort,
			Tunnel:           DefaultTunnelPort,
			WinExecServer:    DefaultWinExecServerPort,
			RemoteExecServer: DefaultRemoteExecServerPort,
		},
		Exec: ExecConfig{
			LocalMatch:  []string{"herdr "},
			EnvPrefixes: []string{"HERDR_"},
		},
		Sync:         SyncConfig{Enabled: true, Whitelist: []string{"skills"}},
		Yolo:         true,
		Keepalive:    15000,
		ReadyTimeout: 15000,
		Proxy:        ProxyConfig{IdleGraceSec: 30},
		Remote: RemoteConfig{
			PrivateHome:              "/opt/codex-remote/home",
			InstallRoot:              "/opt/codex-remote/runtimes/codex",
			RestartOnVersionMismatch: true,
		},
		Codex: CodexConfig{LocalHome: home},
	}
}

func LoadConfig(path string) (*Config, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", abs, err)
	}
	cfg := defaultConfig()
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", abs, err)
	}
	if cfg.SSH.Port == 0 {
		cfg.SSH.Port = 22
	}
	if cfg.SSH.User == "" {
		cfg.SSH.User = "root"
	}
	if cfg.Paths.VCWD == "" {
		cfg.Paths.VCWD = cfg.Paths.RemoteHome
	}
	if cfg.Paths.VCWD == "" {
		cfg.Paths.VCWD = "/root"
	}
	if cfg.SSH.SocksProxy == "" {
		cfg.SSH.SocksProxy = cfg.Paths.SocksProxy
	}
	if cfg.Codex.LocalHome == "" {
		cfg.Codex.LocalHome, _ = os.UserHomeDir()
	}
	if cfg.Exec.LocalMatch == nil {
		cfg.Exec.LocalMatch = []string{"herdr "}
	}
	if cfg.Exec.EnvPrefixes == nil {
		cfg.Exec.EnvPrefixes = []string{"HERDR_"}
	}
	if cfg.Sync.Whitelist == nil {
		cfg.Sync.Whitelist = []string{"skills"}
	}
	if cfg.Keepalive <= 0 {
		cfg.Keepalive = 15000
	}
	if cfg.ReadyTimeout <= 0 {
		cfg.ReadyTimeout = 15000
	}
	if cfg.Proxy.IdleGraceSec <= 0 {
		cfg.Proxy.IdleGraceSec = 30
	}
	if cfg.Remote.PrivateHome == "" {
		cfg.Remote.PrivateHome = "/opt/codex-remote/home"
	}
	if cfg.Remote.InstallRoot == "" {
		cfg.Remote.InstallRoot = "/opt/codex-remote/runtimes/codex"
	}
	if cfg.Ports.Proxy == 0 {
		switch {
		case cfg.Ports.ProxyCwd != 0:
			cfg.Ports.Proxy = cfg.Ports.ProxyCwd
		case cfg.Ports.ProxyRoute != 0:
			cfg.Ports.Proxy = cfg.Ports.ProxyRoute
		default:
			cfg.Ports.Proxy = DefaultProxyPort
		}
	}
	if cfg.Ports.AppServer == 0 {
		cfg.Ports.AppServer = DefaultAppServerPort
	}
	if cfg.Ports.WinExecServer == 0 {
		cfg.Ports.WinExecServer = DefaultWinExecServerPort
	}
	if cfg.Ports.LocalExecServer == 0 {
		cfg.Ports.LocalExecServer = cfg.Ports.WinExecServer
	}
	cfg.Ports.WinExecServer = cfg.Ports.LocalExecServer
	if cfg.Ports.RemoteExecServer == 0 {
		cfg.Ports.RemoteExecServer = DefaultRemoteExecServerPort
	}
	if cfg.Ports.Tunnel == 0 {
		cfg.Ports.Tunnel = DefaultTunnelPort
	}
	cfg.Ports.ProxyCwd = cfg.Ports.Proxy
	cfg.Ports.ProxyRoute = cfg.Ports.Proxy
	cfg.Path = abs
	cfg.Key = configKey(&cfg)
	cfg.Name = resolveName(cfg, abs)
	return &cfg, nil
}

func resolveName(cfg Config, path string) string {
	if n := strings.TrimSpace(cfg.Name); n != "" {
		return n
	}
	base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	base = strings.TrimPrefix(base, ".agent-shim-codex-")
	base = strings.TrimSuffix(base, "-ssh")
	if base == "" {
		return "wsl"
	}
	return base
}

func configKey(cfg *Config) string {
	return fmt.Sprintf("%s|%s@%s:%d", cfg.Path, cfg.SSH.User, cfg.SSH.Host, cfg.SSH.Port)
}

// ApplyGlobalPorts makes the app-server, local exec-server and proxy global
// singletons. Their ports are persisted in .run/global.json; the first launch
// wins and later configs reuse them.
func ApplyGlobalPorts(cfg *Config, runDir string) error {
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(runDir, "global.json")
	want := map[string]int{
		"appServer":       cfg.Ports.AppServer,
		"localExecServer": cfg.Ports.LocalExecServer,
		"proxy":           cfg.Ports.Proxy,
	}
	got := map[string]int{}
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &got)
	}
	merged := map[string]int{}
	for k, v := range want {
		if old, ok := got[k]; ok && old > 0 {
			merged[k] = old
		} else if k == "localExecServer" {
			if old, ok := got["winExecServer"]; ok && old > 0 {
				merged[k] = old
			} else {
				merged[k] = v
			}
		} else {
			merged[k] = v
		}
	}
	// Keep the legacy key for Python-era tooling.
	merged["winExecServer"] = merged["localExecServer"]
	if !equalIntMap(merged, got) {
		data, _ := json.Marshal(merged)
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, data, 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, path); err != nil {
			_ = os.Remove(path)
			_ = os.Rename(tmp, path)
		}
	}
	cfg.Ports.AppServer = merged["appServer"]
	cfg.Ports.LocalExecServer = merged["localExecServer"]
	cfg.Ports.WinExecServer = cfg.Ports.LocalExecServer
	cfg.Ports.Proxy = merged["proxy"]
	cfg.Ports.ProxyCwd = merged["proxy"]
	cfg.Ports.ProxyRoute = merged["proxy"]
	return nil
}

func equalIntMap(a, b map[string]int) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

type configCacheEntry struct {
	mod  time.Time
	size int64
	cfg  *Config
}

type ConfigCache struct {
	mu sync.Mutex
	m  map[string]configCacheEntry
}

func NewConfigCache() *ConfigCache {
	return &ConfigCache{m: map[string]configCacheEntry{}}
}

func (c *ConfigCache) Load(path string) (*Config, error) {
	if path == "" {
		return nil, errors.New("empty config path")
	}
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.m[path]; ok && e.mod.Equal(st.ModTime()) && e.size == st.Size() {
		return e.cfg, nil
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		return nil, err
	}
	c.m[path] = configCacheEntry{mod: st.ModTime(), size: st.Size(), cfg: cfg}
	return cfg, nil
}

func (c *Config) IdleGrace() time.Duration {
	sec := c.Proxy.IdleGraceSec
	if sec <= 0 {
		sec = 30
	}
	return time.Duration(sec) * time.Second
}

func (c *Config) KeepaliveInterval() time.Duration {
	ms := c.Keepalive
	if ms <= 0 {
		ms = 15000
	}
	return time.Duration(ms) * time.Millisecond
}

func (c *Config) ReadyTimeoutDuration() time.Duration {
	ms := c.ReadyTimeout
	if ms <= 0 {
		ms = 15000
	}
	return time.Duration(ms) * time.Millisecond
}

func (c *Config) RemoteCWD() string {
	if v := strings.TrimSpace(c.Paths.VCWD); v != "" {
		return v
	}
	if v := strings.TrimSpace(c.Paths.RemoteHome); v != "" {
		return v
	}
	return "/root"
}

func (c *Config) RemoteHome() string {
	if v := strings.TrimSpace(c.Paths.RemoteHome); v != "" {
		return v
	}
	return c.RemoteCWD()
}

func (c *Config) LocalHome() string {
	if v := strings.TrimSpace(c.Codex.LocalHome); v != "" {
		return v
	}
	h, _ := os.UserHomeDir()
	return h
}

func (c *Config) WinPath() string {
	local := strings.TrimSpace(c.Exec.LocalPath)
	path := strings.TrimSpace(os.Getenv("PATH"))
	if local == "" && runtime.GOOS != "windows" && path == "" {
		path = "/usr/local/bin:/usr/bin:/bin"
	}
	sep := string(os.PathListSeparator)
	switch {
	case local != "" && path != "":
		return local + sep + path
	case local != "":
		return local
	default:
		return path
	}
}

func (c *Config) SocksProxy() string {
	if v := strings.TrimSpace(c.SSH.SocksProxy); v != "" {
		return v
	}
	return strings.TrimSpace(c.Paths.SocksProxy)
}

func (c *Config) ShouldSync(section string) bool {
	if !c.Sync.Enabled {
		return false
	}
	for _, v := range c.Sync.Whitelist {
		if strings.EqualFold(strings.TrimSpace(v), section) {
			return true
		}
	}
	return false
}

// Runtime is a config plus the launch-time identity carried by a token (or a
// registry entry). The proxy never needs a global registry to route a request:
// every connection carries the claims that produced it.
type Runtime struct {
	Config *Config
	Claims *Claims
	Key    string

	Pane       string
	Token      string
	RemoteCWD  string
	RemoteHome string
	LocalHome  string
	WinCWD     string
	WinPath    string
	BashExe    string
	Env        map[string]string

	LocalMatch     []string
	LocalWhitelist []string
	RemoteOverride []string
	Yolo           bool

	CanonicalizeHome bool
	HomeAliases      HomeAliases

	LegacyTunnelURL string
}

func (r *Runtime) ConfigPath() string {
	if r.Claims != nil && r.Claims.ConfigPath != "" {
		return r.Claims.ConfigPath
	}
	if r.Config != nil {
		return r.Config.Path
	}
	return ""
}

func (r *Runtime) Name() string {
	if r.Claims != nil && r.Claims.ConfigName != "" {
		return r.Claims.ConfigName
	}
	if r.Config != nil {
		return r.Config.Name
	}
	return "unknown"
}

func (r *Runtime) Mapper() *Mapper {
	var aliases HomeAliases
	if r.CanonicalizeHome {
		aliases = r.HomeAliases
	}
	return NewMapper(r.LocalHome, r.RemoteHome, r.RemoteCWD, r.WinCWD, aliases)
}

func RuntimeFromConfig(c *Config, claims *Claims) *Runtime {
	rt := &Runtime{
		Config:           c,
		Claims:           claims,
		Key:              c.Key,
		Pane:             "local",
		RemoteCWD:        c.RemoteCWD(),
		RemoteHome:       c.RemoteHome(),
		LocalHome:        c.LocalHome(),
		WinCWD:           c.LocalHome(),
		WinPath:          c.WinPath(),
		BashExe:          resolveBash(c),
		Env:              c.Exec.Env,
		LocalMatch:       c.Exec.LocalMatch,
		LocalWhitelist:   c.Exec.LocalWhitelist,
		RemoteOverride:   c.Exec.RemoteOverride,
		Yolo:             c.Yolo,
		CanonicalizeHome: c.Exec.CanonicalizeHome,
		HomeAliases:      c.Exec.HomeAliases,
	}
	if rt.Env == nil {
		rt.Env = map[string]string{}
	}
	if claims != nil {
		applyClaims(rt, claims)
	}
	return rt
}

func applyClaims(rt *Runtime, cl *Claims) {
	if cl.Pane != "" {
		rt.Pane = cl.Pane
	}
	if cl.RemoteCWD != "" {
		rt.RemoteCWD = cl.RemoteCWD
	}
	if cl.RemoteHome != "" {
		rt.RemoteHome = cl.RemoteHome
	}
	if cl.LocalHome != "" {
		rt.LocalHome = cl.LocalHome
	}
	if cl.WinCWD != "" {
		rt.WinCWD = cl.WinCWD
	}
	if cl.WinPath != "" {
		rt.WinPath = cl.WinPath
	}
	if cl.BashExe != "" {
		rt.BashExe = cl.BashExe
	}
	if cl.Env != nil {
		rt.Env = cl.Env
	}
	if cl.LocalMatch != nil {
		rt.LocalMatch = cl.LocalMatch
	}
	if cl.LocalWhitelist != nil {
		rt.LocalWhitelist = cl.LocalWhitelist
	}
	if cl.RemoteOverride != nil {
		rt.RemoteOverride = cl.RemoteOverride
	}
	if cl.Yolo != nil {
		rt.Yolo = *cl.Yolo
	}
}
