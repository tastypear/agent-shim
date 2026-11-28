package app

import (
	"regexp"
	"strings"
)

// Mapper is the single entry point for path translation. The Python version
// scattered string replacement across the proxy; here every conversion goes
// through one typed object with table-driven tests.
//
// Direction matters:
//   - ToPosix: only applied to *inputs* of remote-routed commands.
//   - ToWin:   only applied to inputs of locally-routed commands.
//   - Command output is never rewritten.
type Mapper struct {
	LocalHome  string // C:\Users\me
	RemoteHome string // /root
	RemoteCWD  string // /root (or a subdirectory)
	WinCWD     string // C:\Users\me

	LocalHomeAliases  []string
	RemoteHomeAliases []string
}

func NewMapper(localHome, remoteHome, remoteCWD, winCWD string, aliases ...HomeAliases) *Mapper {
	if remoteHome == "" {
		remoteHome = "/root"
	}
	if remoteCWD == "" {
		remoteCWD = remoteHome
	}
	if winCWD == "" {
		winCWD = localHome
	}
	m := &Mapper{
		LocalHome:  strings.TrimRight(localHome, `\/`),
		RemoteHome: strings.TrimRight(remoteHome, "/"),
		RemoteCWD:  strings.TrimRight(remoteCWD, "/"),
		WinCWD:     strings.TrimRight(winCWD, `\/`),
	}
	if len(aliases) > 0 {
		m.LocalHomeAliases = aliases[0].LocalValues()
		m.RemoteHomeAliases = aliases[0].Remote
	}
	return m
}

var driveRe = regexp.MustCompile(`^([A-Za-z]):([\\/]|$)`)

func stripFileScheme(s string) string {
	if len(s) >= 7 && strings.EqualFold(s[:7], "file://") {
		rest := s[7:]
		// file:///C:/x -> /C:/x -> C:/x ; file:///root/x -> /root/x
		if strings.HasPrefix(rest, "/") {
			trimmed := strings.TrimPrefix(rest, "/")
			if driveRe.MatchString(trimmed) || strings.HasPrefix(trimmed, "/") {
				return trimmed
			}
			if trimmed == "" {
				return "/"
			}
			return "/" + trimmed
		}
		return rest
	}
	if strings.HasPrefix(s, `\\?\`) {
		return s[4:]
	}
	return s
}

// slashify normalizes separators without touching the rest of a command.
func slashify(s string) string {
	return strings.ReplaceAll(s, `\`, "/")
}

func normalizeHomeAlias(s string) string {
	s = strings.TrimRight(slashify(strings.TrimSpace(stripFileScheme(s))), "/")
	if s == "." || s == "/" {
		return ""
	}
	return s
}

func appendHomeVariants(out []string, home string) []string {
	home = normalizeHomeAlias(home)
	if home == "" {
		return out
	}
	out = append(out, home)
	wh := home
	if len(wh) >= 2 && wh[1] == ':' {
		out = append(out, "/"+strings.ToLower(wh[:1])+wh[2:])
		out = append(out, "/"+strings.ToUpper(wh[:1])+wh[2:])
	}
	return out
}

func (m *Mapper) localHomeVariants() []string {
	out := appendHomeVariants(nil, m.LocalHome)
	for _, v := range m.LocalHomeAliases {
		out = appendHomeVariants(out, v)
	}
	return out
}

func (m *Mapper) remoteHomeVariants() []string {
	var out []string
	out = appendHomeVariants(out, m.RemoteHome)
	for _, v := range m.RemoteHomeAliases {
		out = appendHomeVariants(out, v)
	}
	return out
}

// driveCWDVariants are the Windows spellings an app-server on Windows derives
// from a POSIX cwd (/root -> D:\root). Only exact leading occurrences are
// mapped, which is stricter than the Python "replace anywhere" loop.
func (m *Mapper) driveCWDVariants() []string {
	var out []string
	for _, base := range []string{m.RemoteCWD, m.RemoteHome} {
		if base == "" || base == "/" {
			continue
		}
		rel := strings.TrimPrefix(base, "/")
		if rel == "" {
			continue
		}
		for c := 'A'; c <= 'Z'; c++ {
			for _, sep := range []string{`\`, "/"} {
				out = append(out, string(c)+":"+sep+rel)
				out = append(out, string(c+32)+":"+sep+rel)
			}
		}
	}
	return out
}

func isBoundaryBefore(s string, i int) bool {
	if i == 0 {
		return true
	}
	switch s[i-1] {
	case ' ', '\t', '\n', '\r', '"', '\'', '=', ':', '(', ',', ';', '|', '&', '`':
		return true
	}
	return false
}

func isBoundaryAfter(s string, i int) bool {
	if i >= len(s) {
		return true
	}
	switch s[i] {
	case ' ', '\t', '\n', '\r', '"', '\'', ':', ')', ',', ';', '|', '&', '`', '/':
		return true
	}
	return false
}

// replaceBounded replaces a path variant only when it is a whole token, so a
// literal D:\root inside unrelated text is far less likely to be mangled.
func replaceBounded(s, variant, repl string) string {
	if variant == "" {
		return s
	}
	var b strings.Builder
	i := 0
	for {
		j := strings.Index(s[i:], variant)
		if j < 0 {
			b.WriteString(s[i:])
			break
		}
		j += i
		end := j + len(variant)
		if isBoundaryBefore(s, j) && isBoundaryAfter(s, end) {
			b.WriteString(s[i:j])
			b.WriteString(repl)
			i = end
			continue
		}
		b.WriteString(s[i : j+1])
		i = j + 1
	}
	return b.String()
}

// Windows paths are case-insensitive. This is only used for the win-side
// aliases; remote paths remain case-sensitive.
func replaceBoundedFold(s, variant, repl string) string {
	if variant == "" {
		return s
	}
	lowerS := strings.ToLower(s)
	lowerVariant := strings.ToLower(variant)
	var b strings.Builder
	i := 0
	for {
		j := strings.Index(lowerS[i:], lowerVariant)
		if j < 0 {
			b.WriteString(s[i:])
			break
		}
		j += i
		end := j + len(variant)
		if isBoundaryBefore(s, j) && isBoundaryAfter(s, end) {
			b.WriteString(s[i:j])
			b.WriteString(repl)
			i = end
			continue
		}
		b.WriteString(s[i : j+1])
		i = j + 1
	}
	return b.String()
}

func (m *Mapper) ToPosix(s string) string {
	if s == "" {
		return s
	}
	// Normalize separators first so every variant table is compared in one
	// spelling; the Python version missed `C:\...` because of this.
	out := slashify(stripFileScheme(s))
	for _, v := range m.driveCWDVariants() {
		out = replaceBounded(out, v, m.RemoteCWD)
	}
	for _, v := range m.localHomeVariants() {
		out = replaceBoundedFold(out, v, m.RemoteHome)
	}
	if strings.HasPrefix(out, "~") {
		out = m.RemoteHome + out[1:]
	}
	if strings.HasPrefix(out, "//") && !strings.HasPrefix(out, "///") {
		out = "/" + strings.TrimLeft(out, "/")
	}
	return out
}

func (m *Mapper) ToWin(s string) string {
	if s == "" {
		return s
	}
	out := stripFileScheme(s)
	wh := slashify(m.LocalHome)
	for _, v := range m.remoteHomeVariants() {
		out = replaceBounded(out, v, wh)
	}
	if strings.HasPrefix(out, "~") {
		out = wh + out[1:]
	}
	return out
}

// PathToURI produces a file URI. POSIX absolute paths need three slashes
// (file:///root); Windows paths become file:///C:/...
func PathToURI(s string) string {
	if s == "" {
		return s
	}
	if len(s) >= 7 && strings.EqualFold(s[:7], "file://") {
		return normalizeFileURI(s)
	}
	p := slashify(stripFileScheme(s))
	if strings.HasPrefix(p, "/") {
		return "file://" + p
	}
	return "file:///" + strings.TrimPrefix(p, "/")
}

func normalizeFileURI(s string) string {
	rest := s[7:]
	if strings.HasPrefix(rest, "///") {
		return "file://" + rest[2:]
	}
	if strings.HasPrefix(rest, "//") {
		// file://host/path is not something we generate; keep one slash.
		return "file://" + strings.TrimPrefix(rest, "/")
	}
	if strings.HasPrefix(rest, "/") {
		return "file://" + rest
	}
	return "file:///" + rest
}

func (m *Mapper) ToPosixURI(s string) string {
	return PathToURI(m.ToPosix(s))
}

func (m *Mapper) ToWinURI(s string) string {
	return PathToURI(m.ToWin(s))
}

// MapStrings maps every element, used for argv/envPolicy/sandbox arrays.
func MapStrings(in []any, fn func(string) string) []any {
	out := make([]any, len(in))
	for i, v := range in {
		if s, ok := v.(string); ok {
			out[i] = fn(s)
		} else {
			out[i] = MapValue(v, fn)
		}
	}
	return out
}

// MapValue recursively maps string leaves of decoded JSON.
func MapValue(v any, fn func(string) string) any {
	switch t := v.(type) {
	case string:
		return fn(t)
	case []any:
		out := make([]any, len(t))
		for i := range t {
			out[i] = MapValue(t[i], fn)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, vv := range t {
			out[k] = MapValue(vv, fn)
		}
		return out
	default:
		return v
	}
}
