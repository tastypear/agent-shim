package app

import (
	"context"
	"net"
	"net/http"
	"time"

	xproxy "golang.org/x/net/proxy"
)

func socksTransport(socks string) (*http.Transport, error) {
	d, err := xproxy.SOCKS5("tcp", normalizeSocks(socks), nil, &net.Dialer{Timeout: 20 * time.Second})
	if err != nil {
		return nil, err
	}
	return &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if cd, ok := d.(xproxy.ContextDialer); ok {
				return cd.DialContext(ctx, network, addr)
			}
			return d.Dial(network, addr)
		},
		TLSHandshakeTimeout:   20 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
	}, nil
}
