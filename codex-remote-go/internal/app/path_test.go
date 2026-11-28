package app

import "testing"

func TestToPosix(t *testing.T) {
	m := NewMapper(`C:\Users\me`, "/root", "/root", `C:\Users\me`)
	cases := []struct{ in, want string }{
		{`C:\Users\me\.codex\skills`, "/root/.codex/skills"},
		{"C:/Users/me/.codex", "/root/.codex"},
		{"file:///C:/Users/me/.codex/skills", "/root/.codex/skills"},
		{"file://C:/Users/me/.codex", "/root/.codex"},
		{"file:///root/x", "/root/x"},
		{"/c/Users/me/.codex", "/root/.codex"},
		{"/C/Users/me/.codex", "/root/.codex"},
		{`D:\root\project`, "/root/project"},
		{"D:/root/project", "/root/project"},
		{"file:///D:/root/project", "/root/project"},
		{"~/.codex", "/root/.codex"},
		{"~", "/root"},
		{`\\?\C:\Users\me\x`, "/root/x"},
		{"cat C:/Users/me/a.txt", "cat /root/a.txt"},
		// A literal path that merely contains the drive spelling as a
		// substring must not be rewritten (bounded match).
		{"echo xD:/rooty", "echo xD:/rooty"},
		{"/tmp/D:/root/keep", "/tmp/D:/root/keep"},
	}
	for _, c := range cases {
		if got := m.ToPosix(c.in); got != c.want {
			t.Errorf("ToPosix(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestToWin(t *testing.T) {
	m := NewMapper(`C:\Users\me`, "/root", "/root", `C:\Users\me`)
	cases := []struct{ in, want string }{
		{"/root/.codex/skills", "C:/Users/me/.codex/skills"},
		{"file:///root/x", "C:/Users/me/x"},
		{"~/.codex", "C:/Users/me/.codex"},
		{"/etc/hosts", "/etc/hosts"},
	}
	for _, c := range cases {
		if got := m.ToWin(c.in); got != c.want {
			t.Errorf("ToWin(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestPathToURI(t *testing.T) {
	cases := []struct{ in, want string }{
		{"/root", "file:///root"},
		{"/root/x", "file:///root/x"},
		{`C:\Users\me`, "file:///C:/Users/me"},
		{"C:/Users/me", "file:///C:/Users/me"},
		{"file:///root/x", "file:///root/x"},
		{"file://root/x", "file:///root/x"},
		{"file:///D:/root/x", "file:///D:/root/x"},
	}
	for _, c := range cases {
		if got := PathToURI(c.in); got != c.want {
			t.Errorf("PathToURI(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestMapValue(t *testing.T) {
	m := NewMapper(`C:\Users\me`, "/root", "/root", `C:\Users\me`)
	in := map[string]any{
		"cwd":  `C:\Users\me\proj`,
		"list": []any{`C:\Users\me\a`, 3},
	}
	out := MapValue(in, m.ToPosix).(map[string]any)
	if out["cwd"] != "/root/proj" {
		t.Fatalf("cwd = %v", out["cwd"])
	}
	list := out["list"].([]any)
	if list[0] != "/root/a" || list[1] != 3 {
		t.Fatalf("list = %v", list)
	}
}

func TestHomeAliases(t *testing.T) {
	m := NewMapper(`C:\Users\me`, "/root", "/root", `C:\Users\me`, HomeAliases{
		Local: []string{
			`C:\Users\me`,
			"C:/Users/me",
			"/c/Users/me",
			"/mnt/c/Users/me",
		},
		Remote: []string{"/root", "/home/me"},
	})

	posix := []struct{ in, want string }{
		{`C:\Users\me\.codex`, "/root/.codex"},
		{"C:/USERS/ME/.codex", "/root/.codex"},
		{"/c/Users/me/.codex", "/root/.codex"},
		{"/mnt/c/Users/me/.codex", "/root/.codex"},
		{"/rootfs", "/rootfs"},
	}
	for _, c := range posix {
		if got := m.ToPosix(c.in); got != c.want {
			t.Errorf("ToPosix(%q) = %q, want %q", c.in, got, c.want)
		}
	}

	win := []struct{ in, want string }{
		{"/root/.codex", "C:/Users/me/.codex"},
		{"/home/me/.codex", "C:/Users/me/.codex"},
		{"/home/meadow", "/home/meadow"},
		{"cat /root/.codex", "cat C:/Users/me/.codex"},
	}
	for _, c := range win {
		if got := m.ToWin(c.in); got != c.want {
			t.Errorf("ToWin(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestCanonicalizeHomeSwitch(t *testing.T) {
	cfg := testConfig(t)
	cfg.Exec.HomeAliases = HomeAliases{Remote: []string{"/home/me"}}

	cfg.Exec.CanonicalizeHome = false
	if got := RuntimeFromConfig(cfg, nil).Mapper().ToWin("/home/me/.codex"); got != "/home/me/.codex" {
		t.Fatalf("aliases must be disabled when switch is off: %q", got)
	}

	cfg.Exec.CanonicalizeHome = true
	if got := RuntimeFromConfig(cfg, nil).Mapper().ToWin("/home/me/.codex"); got != "C:/Users/me/.codex" {
		t.Fatalf("aliases must be enabled when switch is on: %q", got)
	}
}

func TestHomeAliasesLegacyWin(t *testing.T) {
	h := HomeAliases{Win: []string{"/legacy"}}
	got := h.LocalValues()
	if len(got) != 1 || got[0] != "/legacy" {
		t.Fatalf("legacy win aliases = %v", got)
	}
}
