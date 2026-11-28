package app

import (
	"context"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// WS is a small single-writer wrapper around gorilla. Ping/pong goes through
// WriteControl, which gorilla allows concurrently with WriteMessage.
type WS struct {
	c    *websocket.Conn
	mu   sync.Mutex
	once sync.Once
}

func WrapWS(c *websocket.Conn) *WS {
	c.SetReadLimit(64 << 20)
	return &WS{c: c}
}

func (w *WS) Conn() *websocket.Conn { return w.c }

func (w *WS) Write(data []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.c.SetWriteDeadline(time.Now().Add(30 * time.Second))
	return w.c.WriteMessage(websocket.TextMessage, data)
}

func (w *WS) Read() ([]byte, error) {
	_, data, err := w.c.ReadMessage()
	return data, err
}

func (w *WS) Close() error {
	var err error
	w.once.Do(func() {
		w.mu.Lock()
		_ = w.c.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
			time.Now().Add(time.Second))
		w.mu.Unlock()
		err = w.c.Close()
	})
	return err
}

func (w *WS) PingLoop(ctx context.Context, every time.Duration) {
	if every <= 0 {
		every = 30 * time.Second
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := w.c.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
				_ = w.Close()
				return
			}
		}
	}
}

type DialOpts struct {
	Header    http.Header
	NetDial   func(ctx context.Context, network, addr string) (net.Conn, error)
	Timeout   time.Duration
	KeepAlive time.Duration
}

func DialWS(ctx context.Context, url string, o DialOpts) (*WS, *http.Response, error) {
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	d := websocket.Dialer{
		HandshakeTimeout: timeout,
		NetDialContext:   o.NetDial,
	}
	c, resp, err := d.DialContext(ctx, url, o.Header)
	if err != nil {
		return nil, resp, err
	}
	w := WrapWS(c)
	if o.KeepAlive > 0 {
		go w.PingLoop(context.Background(), o.KeepAlive)
	}
	return w, resp, nil
}
