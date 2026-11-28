package app

import (
	"encoding/json"
	"testing"
)

func TestRouterTarget(t *testing.T) {
	r := &Router{
		LocalMatch:     []string{"herdr ", "HERDR_"},
		LocalWhitelist: []string{"/tmp/pane.jsonl"},
		RemoteOverride: []string{"remote-please"},
	}
	cases := []struct {
		argv []string
		want string
	}{
		{[]string{"bash", "-lc", "uname -a"}, "remote"},
		{[]string{"bash", "-lc", "herdr pane list"}, "local"},
		{[]string{"herdr", "pane", "list"}, "local"},
		{splitPathArg(`C:\Program Files\herdr\herdr.exe`), "local"},
		{[]string{"cat", "/root/.codex/skills/herdr/SKILL.md"}, "remote"},
		{[]string{"bash", "-lc", "echo $HERDR_PANE_ID"}, "local"},
		{[]string{"bash", "-lc", "echo ${HERDR_ENV}"}, "local"},
		{[]string{"bash", "-lc", "cat /tmp/pane.jsonl"}, "local"},
		{[]string{"bash", "-lc", "herdr pane list remote-please"}, "remote"},
		{[]string{"bash", "-lc", "cat notes.txt"}, "remote"},
	}
	for _, c := range cases {
		if got := r.Target(c.argv); got != c.want {
			t.Errorf("Target(%v) = %q, want %q", c.argv, got, c.want)
		}
	}
}

func splitPathArg(s string) []string { return []string{s, "pane", "list"} }

func TestCWDInjection(t *testing.T) {
	yolo := true
	rt := &Runtime{
		RemoteCWD: "/root/proj",
		Yolo:      yolo,
		Claims:    &Claims{EnvID: "env-1"},
	}
	p := map[string]any{}
	if !applyCWDInjection(rt, "thread/start", p) {
		t.Fatal("thread/start should be injected")
	}
	if p["cwd"] != "/root/proj" || p["approvalPolicy"] != "never" || p["sandbox"] != "danger-full-access" {
		t.Fatalf("thread/start params = %v", p)
	}
	if _, ok := p["sandboxPolicy"]; ok {
		t.Fatal("thread/start must not set sandboxPolicy")
	}
	envs := p["environments"].([]any)
	first := envs[0].(map[string]any)
	if first["environmentId"] != "env-1" || first["cwd"] != "/root/proj" {
		t.Fatalf("environments = %v", envs)
	}

	p = map[string]any{}
	applyCWDInjection(rt, "turn/start", p)
	sp, ok := p["sandboxPolicy"].(map[string]any)
	if !ok || sp["type"] != "dangerFullAccess" {
		t.Fatalf("turn/start sandboxPolicy = %v", p["sandboxPolicy"])
	}
	if _, ok := p["sandbox"]; ok {
		t.Fatal("turn/start must not set sandbox")
	}

	// deny_unknown_fields method must be passed through untouched.
	before := map[string]any{"threadId": "t", "turnId": "u", "model": "m"}
	p = map[string]any{"threadId": "t", "turnId": "u", "model": "m"}
	if applyCWDInjection(rt, "turn/settings/update", p) {
		t.Fatal("turn/settings/update must not be injected")
	}
	a, _ := json.Marshal(before)
	b, _ := json.Marshal(p)
	if string(a) != string(b) {
		t.Fatalf("params changed: %s vs %s", a, b)
	}

	// Non-yolo: cwd still forced, no approval/sandbox.
	rt.Yolo = false
	p = map[string]any{}
	applyCWDInjection(rt, "thread/start", p)
	if _, ok := p["approvalPolicy"]; ok {
		t.Fatal("yolo=false must not force approvalPolicy")
	}
	if p["cwd"] != "/root/proj" {
		t.Fatal("cwd should still be forced")
	}
}

func TestEnsureExperimental(t *testing.T) {
	m := map[string]any{"method": "initialize", "params": map[string]any{}}
	if !ensureExperimental(m) {
		t.Fatal("expected a change")
	}
	caps := m["params"].(map[string]any)["capabilities"].(map[string]any)
	if caps["experimentalApi"] != true {
		t.Fatal("experimentalApi not set")
	}
	if ensureExperimental(m) {
		t.Fatal("second call should be a no-op")
	}
	other := map[string]any{"method": "thread/start"}
	if ensureExperimental(other) {
		t.Fatal("non-initialize must be untouched")
	}
}
