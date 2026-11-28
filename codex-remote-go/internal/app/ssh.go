package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
	"golang.org/x/net/proxy"
)

type SSHDialer struct {
	cfg *Config
}

func NewSSHDialer(cfg *Config) *SSHDialer {
	return &SSHDialer{cfg: cfg}
}

func (d *SSHDialer) clientConfig() (*ssh.ClientConfig, error) {
	c := d.cfg
	auths := []ssh.AuthMethod{}
	if key := strings.TrimSpace(c.SSH.KeyPath); key != "" {
		key = expandHome(key)
		data, err := os.ReadFile(key)
		if err != nil {
			return nil, fmt.Errorf("read ssh key %s: %w", key, err)
		}
		var signer ssh.Signer
		if c.SSH.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(data, []byte(c.SSH.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey(data)
		}
		if err != nil {
			return nil, fmt.Errorf("parse ssh key %s: %w", key, err)
		}
		auths = append(auths, ssh.PublicKeys(signer))
	}
	if c.SSH.Password != "" {
		auths = append(auths, ssh.Password(c.SSH.Password))
	}
	if len(auths) == 0 {
		// Fall back to the default identity files so the usual ~/.ssh setup works.
		for _, name := range []string{"id_ed25519", "id_rsa", "id_ecdsa"} {
			p := expandHome("~/.ssh/" + name)
			if data, err := os.ReadFile(p); err == nil {
				if signer, err := ssh.ParsePrivateKey(data); err == nil {
					auths = append(auths, ssh.PublicKeys(signer))
				}
			}
		}
	}
	if len(auths) == 0 {
		return nil, errors.New("no ssh auth method: set ssh.keyPath or ssh.password")
	}

	hostKeyCallback, err := d.hostKeyCallback()
	if err != nil {
		return nil, err
	}
	user := c.SSH.User
	if user == "" {
		user = "root"
	}
	return &ssh.ClientConfig{
		User:            user,
		Auth:            auths,
		HostKeyCallback: hostKeyCallback,
		Timeout:         20 * time.Second,
	}, nil
}

func (d *SSHDialer) hostKeyCallback() (ssh.HostKeyCallback, error) {
	known := strings.TrimSpace(d.cfg.SSH.KnownHosts)
	if known == "" {
		known = expandHome("~/.ssh/known_hosts")
	}
	if st, err := os.Stat(known); err == nil && !st.IsDir() {
		cb, err := knownhosts.New(known)
		if err != nil {
			return nil, fmt.Errorf("load known_hosts %s: %w", known, err)
		}
		return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
			err := cb(hostname, remote, key)
			if err == nil {
				return nil
			}
			var ke *knownhosts.KeyError
			if errors.As(err, &ke) && len(ke.Want) == 0 && !d.cfg.SSH.StrictHostKey {
				// Trust on first use: unknown host accepted and pinned for this
				// process; a *changed* key still fails.
				return nil
			}
			return err
		}, nil
	}
	if d.cfg.SSH.StrictHostKey {
		return nil, fmt.Errorf("strictHostKey=true but %s is missing", known)
	}
	// No known_hosts entry yet: pin on first use, but still refuse silent key
	// changes by recording the key in memory for this process.
	var mu sync.Mutex
	seen := map[string]ssh.PublicKey{}
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		mu.Lock()
		defer mu.Unlock()
		if prev, ok := seen[hostname]; ok {
			if string(prev.Marshal()) != string(key.Marshal()) {
				return fmt.Errorf("host key for %s changed", hostname)
			}
			return nil
		}
		seen[hostname] = key
		return nil
	}, nil
}

func (d *SSHDialer) Dial(ctx context.Context) (*ssh.Client, error) {
	cc, err := d.clientConfig()
	if err != nil {
		return nil, err
	}
	addr := net.JoinHostPort(d.cfg.SSH.Host, fmt.Sprintf("%d", d.cfg.SSH.Port))
	var raw net.Conn
	socks := d.cfg.SocksProxy()
	if socks != "" {
		dialer, err := proxy.SOCKS5("tcp", normalizeSocks(socks), nil, &net.Dialer{Timeout: 20 * time.Second})
		if err != nil {
			return nil, fmt.Errorf("socks5 dialer: %w", err)
		}
		raw, err = dialer.Dial("tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("socks5 dial %s: %w", addr, err)
		}
	} else {
		var nd net.Dialer
		raw, err = nd.DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("dial %s: %w", addr, err)
		}
	}
	c, chans, reqs, err := ssh.NewClientConn(raw, addr, cc)
	if err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("ssh handshake %s: %w", addr, err)
	}
	return ssh.NewClient(c, chans, reqs), nil
}

func normalizeSocks(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "socks5://")
	s = strings.TrimPrefix(s, "socks5h://")
	return s
}

func expandHome(p string) string {
	if strings.HasPrefix(p, "~/") || p == "~" {
		home, _ := os.UserHomeDir()
		if p == "~" {
			return home
		}
		return filepath.Join(home, p[2:])
	}
	return p
}

// RemoteSSH is a lazily (re)connected SSH client with keepalive.
type RemoteSSH struct {
	dialer     *SSHDialer
	mu         sync.Mutex
	client     *ssh.Client
	connecting chan struct{}
	closed     bool
	lastErr    error
}

func NewRemoteSSH(cfg *Config) *RemoteSSH {
	return &RemoteSSH{dialer: NewSSHDialer(cfg)}
}

func (r *RemoteSSH) Client(ctx context.Context) (*ssh.Client, error) {
	r.mu.Lock()
	if r.client != nil {
		c := r.client
		r.mu.Unlock()
		return c, nil
	}
	if r.connecting != nil {
		ch := r.connecting
		r.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return r.Client(ctx)
	}
	ch := make(chan struct{})
	r.connecting = ch
	r.mu.Unlock()

	client, err := r.dialer.Dial(ctx)

	r.mu.Lock()
	r.connecting = nil
	if err != nil {
		r.lastErr = err
		r.mu.Unlock()
		close(ch)
		return nil, err
	}
	r.client = client
	r.lastErr = nil
	r.mu.Unlock()
	close(ch)
	go r.keepalive(client)
	return client, nil
}

func (r *RemoteSSH) keepalive(c *ssh.Client) {
	interval := r.dialer.cfg.KeepaliveInterval()
	if interval < 5*time.Second {
		interval = 15 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		r.mu.Lock()
		if r.client != c {
			r.mu.Unlock()
			return
		}
		r.mu.Unlock()
		// A laptop that slept leaves a half-open TCP connection: SendRequest
		// would block until the OS gives up (minutes). Bound the wait, and on
		// timeout close the client so every blocked channel fails fast.
		done := make(chan error, 1)
		go func() {
			_, _, err := c.SendRequest("keepalive@openssh.com", true, nil)
			done <- err
		}()
		select {
		case err := <-done:
			if err != nil {
				r.Invalidate(c)
				return
			}
		case <-time.After(interval):
			r.Invalidate(c)
			return
		}
	}
}

func (r *RemoteSSH) Invalidate(c *ssh.Client) {
	r.mu.Lock()
	if r.client == c {
		r.client = nil
	}
	r.mu.Unlock()
	_ = c.Close()
}

func (r *RemoteSSH) Close() {
	r.mu.Lock()
	c := r.client
	r.client = nil
	r.closed = true
	r.mu.Unlock()
	if c != nil {
		_ = c.Close()
	}
}

func (r *RemoteSSH) DialTCP(ctx context.Context, addr string) (net.Conn, error) {
	c, err := r.Client(ctx)
	if err != nil {
		return nil, err
	}
	type res struct {
		conn net.Conn
		err  error
	}
	ch := make(chan res, 1)
	go func() {
		conn, err := c.Dial("tcp", addr)
		ch <- res{conn, err}
	}()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case v := <-ch:
		if v.err != nil {
			r.Invalidate(c)
			return nil, v.err
		}
		return &channelConn{Conn: v.conn, onClose: func() {}}, nil
	}
}

type channelConn struct {
	net.Conn
	onClose func()
}

// ssh channel connections do not support deadlines. gorilla's dialer sets one
// for the handshake, so absorb it instead of failing with
// "ssh: tcpChan: deadline not supported".
func (c *channelConn) SetDeadline(time.Time) error      { return nil }
func (c *channelConn) SetReadDeadline(time.Time) error  { return nil }
func (c *channelConn) SetWriteDeadline(time.Time) error { return nil }

func (c *channelConn) Close() error {
	err := c.Conn.Close()
	if c.onClose != nil {
		c.onClose()
	}
	return err
}

// Run executes a command and returns stdout/stderr/exit code.
func (r *RemoteSSH) Run(ctx context.Context, cmd string, timeout time.Duration) (string, string, int, error) {
	c, err := r.Client(ctx)
	if err != nil {
		return "", "", -1, err
	}
	session, err := c.NewSession()
	if err != nil {
		r.Invalidate(c)
		return "", "", -1, err
	}
	defer session.Close()
	var out, errb strings.Builder
	session.Stdout = &out
	session.Stderr = &errb
	if err := session.Start(cmd); err != nil {
		return "", "", -1, err
	}
	done := make(chan error, 1)
	go func() { done <- session.Wait() }()
	var runErr error
	if timeout > 0 {
		t := time.NewTimer(timeout)
		defer t.Stop()
		select {
		case runErr = <-done:
		case <-ctx.Done():
			_ = session.Close()
			runErr = ctx.Err()
		case <-t.C:
			_ = session.Close()
			runErr = fmt.Errorf("command timed out after %s", timeout)
		}
	} else {
		runErr = <-done
	}
	code := 0
	if runErr != nil {
		var ee *ssh.ExitError
		if errors.As(runErr, &ee) {
			code = ee.ExitStatus()
			runErr = nil
		}
	}
	return out.String(), errb.String(), code, runErr
}

// RunDetached starts a background command without waiting for the SSH channel
// to reach EOF (the Python "nohup + &" trap).
func (r *RemoteSSH) RunDetached(ctx context.Context, cmd string) error {
	c, err := r.Client(ctx)
	if err != nil {
		return err
	}
	session, err := c.NewSession()
	if err != nil {
		r.Invalidate(c)
		return err
	}
	if err := session.Start(cmd); err != nil {
		_ = session.Close()
		return err
	}
	go func() {
		_ = session.Wait()
		_ = session.Close()
	}()
	return nil
}

func (r *RemoteSSH) Sftp(ctx context.Context) (*sftp.Client, error) {
	c, err := r.Client(ctx)
	if err != nil {
		return nil, err
	}
	return sftp.NewClient(c)
}
