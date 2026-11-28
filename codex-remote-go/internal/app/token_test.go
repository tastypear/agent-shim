package app

import (
	"strings"
	"testing"
)

func TestTokenRoundTrip(t *testing.T) {
	k := NewTokenKeyForTests([]byte("0123456789abcdef0123456789abcdef"))
	yolo := true
	in := &Claims{
		ConfigPath: `D:\x\cfg.json`,
		ConfigName: "wsl",
		Pane:       "w6:pB-1234",
		RemoteCWD:  "/root",
		RemoteHome: "/root",
		LocalHome:  `C:\Users\me`,
		WinPath:    strings.Repeat(`C:\very-long-path-segment\bin;`, 120),
		Env:        map[string]string{"HERDR_PANE_ID": "w6:pB"},
		LocalMatch: []string{"herdr ", "HERDR_"},
		Yolo:       &yolo,
	}
	tok, err := k.Encode(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(tok) > 4096 {
		t.Fatalf("token unexpectedly long: %d", len(tok))
	}
	out, err := k.Decode(tok)
	if err != nil {
		t.Fatal(err)
	}
	if out.Pane != in.Pane || out.ConfigPath != in.ConfigPath || out.Env["HERDR_PANE_ID"] != "w6:pB" {
		t.Fatalf("round trip mismatch: %+v", out)
	}
	if out.WinPath != in.WinPath {
		t.Fatal("compressed payload did not round-trip")
	}
}

func TestTokenTamper(t *testing.T) {
	k := NewTokenKeyForTests([]byte("0123456789abcdef0123456789abcdef"))
	tok, _ := k.Encode(&Claims{Pane: "p1"})
	// Flip a character in the payload segment (the trailing base64 char can be
	// padding-equivalent).
	body := tok[len(tokenPrefix):]
	dot := strings.IndexByte(body, '.')
	if dot < 0 {
		t.Fatal("unexpected token layout")
	}
	payload := []byte(body[:dot])
	if payload[0] == 'A' {
		payload[0] = 'B'
	} else {
		payload[0] = 'A'
	}
	tampered := tokenPrefix + string(payload) + body[dot:]
	if _, err := k.Decode(tampered); err == nil {
		t.Fatal("tampered token must fail")
	}
	other := NewTokenKeyForTests([]byte("ffffffffffffffffffffffffffffffff"))
	if _, err := other.Decode(tok); err == nil {
		t.Fatal("token signed by another key must fail")
	}
	if _, err := k.Decode("plain-hex-token"); err == nil {
		t.Fatal("legacy token must not decode as cr1")
	}
}

func TestEnvID(t *testing.T) {
	a := EnvIDForToken("cr1.a.b")
	b := EnvIDForToken("cr1.a.b")
	c := EnvIDForToken("cr1.a.c")
	if a != b || a == c {
		t.Fatalf("env ids: %s %s %s", a, b, c)
	}
	if !strings.HasPrefix(a, "cr1-") || len(a) > 40 {
		t.Fatalf("unexpected env id %q", a)
	}
}

func TestBearerToken(t *testing.T) {
	if got := BearerToken("Bearer abc"); got != "abc" {
		t.Fatal(got)
	}
	if got := BearerToken("bearer  abc "); got != "abc" {
		t.Fatal(got)
	}
	if got := BearerToken("abc"); got != "abc" {
		t.Fatal(got)
	}
}
