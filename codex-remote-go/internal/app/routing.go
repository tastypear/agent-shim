package app

import (
	"encoding/json"
	"path"
	"strings"
)

// RouteTarget returns "local" or "remote".
//
// The Python version matched raw substrings over the whole joined argv, which
// misfires on paths that merely contain a keyword. Here we match the basename
// of argv[0], whole command tokens in a shell script, and env var references
// such as $HERDR_PANE_ID for prefix patterns.
type Router struct {
	LocalMatch     []string
	LocalWhitelist []string
	RemoteOverride []string
}

func NewRouter(rt *Runtime) *Router {
	return &Router{
		LocalMatch:     rt.LocalMatch,
		LocalWhitelist: rt.LocalWhitelist,
		RemoteOverride: rt.RemoteOverride,
	}
}

func (r *Router) Target(argv []string) string {
	if len(argv) == 0 {
		return "remote"
	}
	if r.matchesAny(r.RemoteOverride, argv) {
		return "remote"
	}
	if r.matchesAny(r.LocalMatch, argv) || r.matchesAny(r.LocalWhitelist, argv) {
		return "local"
	}
	return "remote"
}

func (r *Router) matchesAny(patterns, argv []string) bool {
	if len(patterns) == 0 {
		return false
	}
	cmd := argv[0]
	base := strings.ToLower(path.Base(strings.ReplaceAll(cmd, `\`, "/")))
	base = strings.TrimSuffix(base, ".exe")
	for _, raw := range patterns {
		p := strings.TrimSpace(raw)
		if p == "" {
			continue
		}
		if strings.HasSuffix(p, " ") {
			// Legacy "herdr " form: exact command word.
			p = strings.TrimSpace(p)
			if base == p || strings.EqualFold(cmd, p) {
				return true
			}
			if scriptMatchesWord(argv, p) {
				return true
			}
			continue
		}
		if strings.HasPrefix(p, "$") || strings.HasSuffix(p, "_") {
			name := strings.TrimPrefix(strings.TrimPrefix(p, "$"), "{")
			name = strings.TrimSuffix(name, "}")
			if scriptReferencesEnv(argv, name) || envKeyMatches(argv, name) {
				return true
			}
			continue
		}
		if base == p || strings.EqualFold(cmd, p) {
			return true
		}
		if scriptMatchesWord(argv, p) {
			return true
		}
	}
	return false
}

func scriptMatchesWord(argv []string, word string) bool {
	for _, a := range argv[1:] {
		if a == "-c" || a == "-lc" || a == "-ic" || strings.HasPrefix(a, "-") {
			continue
		}
		for _, tok := range splitScript(a) {
			if tok == word {
				return true
			}
		}
	}
	return false
}

func splitScript(s string) []string {
	repl := strings.NewReplacer(";", " ", "|", " ", "&", " ", "\n", " ", "\t", " ", "(", " ", ")", " ", "`", " ")
	s = repl.Replace(s)
	var out []string
	for _, f := range strings.Fields(s) {
		f = strings.Trim(f, `"'`)
		if f == "" {
			continue
		}
		if i := strings.IndexByte(f, '='); i > 0 && !strings.HasPrefix(f, "/") {
			f = f[i+1:]
		}
		out = append(out, f)
	}
	return out
}

func scriptReferencesEnv(argv []string, prefix string) bool {
	prefix = strings.TrimSuffix(prefix, "_")
	for _, a := range argv[1:] {
		if strings.Contains(a, "$"+prefix+"_") || strings.Contains(a, "${"+prefix+"_") {
			return true
		}
	}
	return false
}

func envKeyMatches(argv []string, prefix string) bool {
	prefix = strings.ToUpper(strings.TrimSuffix(prefix, "_"))
	for _, a := range argv[1:] {
		for _, tok := range splitScript(a) {
			if strings.HasPrefix(strings.ToUpper(tok), prefix+"_") {
				return true
			}
		}
	}
	return false
}

// injection is the per-method yolo/cwd injection table. Only fields the
// method's schema declares are touched; turn/settings/update is deliberately
// left alone because its params struct has deny_unknown_fields.
type injection struct {
	environments bool
	cwd          bool
	approval     bool
	sandboxMode  bool // thread/*: sandbox: "danger-full-access"
	sandboxPol   bool // turn/*: sandboxPolicy: {type: dangerFullAccess}
}

var methodInjections = map[string]injection{
	"thread/start":           {environments: true, cwd: true, approval: true, sandboxMode: true},
	"thread/resume":          {cwd: true, approval: true, sandboxMode: true},
	"thread/fork":            {cwd: true, approval: true, sandboxMode: true},
	"thread/settings/update": {environments: true, cwd: true, approval: true, sandboxPol: true},
	"turn/start":             {environments: true, cwd: true, approval: true, sandboxPol: true},
}

func applyCWDInjection(rt *Runtime, method string, params map[string]any) bool {
	inj, ok := methodInjections[method]
	if !ok {
		return false
	}
	if inj.cwd {
		params["cwd"] = rt.RemoteCWD
	}
	if inj.environments {
		params["environments"] = []any{map[string]any{
			"environmentId": rt.EnvID(),
			"cwd":           rt.RemoteCWD,
		}}
	}
	if rt.Yolo {
		if inj.approval {
			params["approvalPolicy"] = "never"
		}
		if inj.sandboxMode {
			params["sandbox"] = "danger-full-access"
		}
		if inj.sandboxPol {
			params["sandboxPolicy"] = map[string]any{"type": "dangerFullAccess"}
		}
	}
	return true
}

func ensureExperimental(msg map[string]any) bool {
	if m, _ := msg["method"].(string); m != "initialize" {
		return false
	}
	params, _ := msg["params"].(map[string]any)
	if params == nil {
		params = map[string]any{}
		msg["params"] = params
	}
	caps, _ := params["capabilities"].(map[string]any)
	if caps == nil {
		caps = map[string]any{}
		params["capabilities"] = caps
	}
	if caps["experimentalApi"] == true {
		return false
	}
	caps["experimentalApi"] = true
	return true
}

func decodeMessage(raw []byte) (map[string]any, bool) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, false
	}
	return m, true
}

func encodeMessage(m map[string]any) []byte {
	b, _ := json.Marshal(m)
	return b
}

func (rt *Runtime) EnvID() string {
	if rt.Claims != nil && rt.Claims.EnvID != "" {
		return rt.Claims.EnvID
	}
	if rt.Token != "" {
		return EnvIDForToken(rt.Token)
	}
	return "env"
}
