package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"agent-shim/codex-remote-go/internal/app"
)

// version is overridden at release build time with
// -ldflags "-X main.version=<tag version>".
var version = "1.0.0"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	// Drop-in compatibility with the Python launcher's flags.
	if os.Args[1] == "--stop" || os.Args[1] == "-stop" {
		runStop(os.Args[2:])
		return
	}
	if os.Args[1] == "-c" || os.Args[1] == "--config" {
		if len(os.Args) < 3 {
			fmt.Fprintln(os.Stderr, "error: --config needs a path")
			os.Exit(2)
		}
		runLaunch(append([]string{"--config", os.Args[2]}, os.Args[3:]...))
		return
	}
	switch os.Args[1] {
	case "launch":
		runLaunch(os.Args[2:])
	case "proxy":
		runProxy(os.Args[2:])
	case "setup":
		runSetup(os.Args[2:])
	case "stop":
		runStop(os.Args[2:])
	case "test":
		runTest(os.Args[2:])
	case "token":
		runToken(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Printf("codex-remote-go %s\n", version)
	case "help", "--help", "-h":
		usage()
	default:
		// Convenience: `codex-remote <config.json> [args...]` behaves like launch.
		if st, err := os.Stat(os.Args[1]); err == nil && !st.IsDir() {
			runLaunch(os.Args[1:])
			return
		}
		fmt.Fprintf(os.Stderr, "unknown command %q\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `codex-remote-go - Codex TUI remote execution adapter

Usage:
  codex-remote launch --config <file> [-- <codex args>...]
  codex-remote proxy  --config <file>
  codex-remote setup  --config <file>
  codex-remote stop   --config <file> [--shared]
  codex-remote test   --config <file> [--pane <id>]
  codex-remote token  --config <file> [--pane <id>] [--env-file <path>]

Environment:
  CODEX_REMOTE_CONFIG  default config path for launch
  CODEX_REMOTE_RUN     override the .run directory
  CODEX_REMOTE_CACHE   override the .cache directory
`)
}

func defaultConfig() string {
	if v := os.Getenv("CODEX_REMOTE_CONFIG"); v != "" {
		return v
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Join(filepath.Dir(filepath.Dir(exe)), ".agent-shim-codex-wsl-ssh.json")
}

func splitArgs(args []string) (flags, rest []string) {
	for i, a := range args {
		if a == "--" {
			return args[:i], args[i+1:]
		}
	}
	return args, nil
}

func runLaunch(args []string) {
	flagArgs, rest := splitArgs(args)
	fs := flag.NewFlagSet("launch", flag.ExitOnError)
	cfgPath := fs.String("config", defaultConfig(), "connection config")
	noTUI := fs.Bool("no-tui", false, "assemble the stack but do not start the TUI")
	_ = fs.Parse(flagArgs)
	if rest == nil {
		rest = fs.Args()
	}
	if err := app.Launch(app.LaunchOptions{ConfigPath: *cfgPath, Args: rest, NoTUI: *noTUI}); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func runProxy(args []string) {
	fs := flag.NewFlagSet("proxy", flag.ExitOnError)
	cfgPath := fs.String("config", defaultConfig(), "connection config")
	_ = fs.Parse(args)
	cfg, err := app.LoadConfig(*cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	if err := app.ApplyGlobalPorts(cfg, app.RunDir()); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	log, err := app.NewLogger(filepath.Join(app.RunDir(), cfg.Name, "proxy.log"), false)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	defer log.Close()
	if err := app.ServeProxy(cfg, log); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func runSetup(args []string) {
	fs := flag.NewFlagSet("setup", flag.ExitOnError)
	cfgPath := fs.String("config", defaultConfig(), "connection config")
	_ = fs.Parse(args)
	if err := app.Launch(app.LaunchOptions{ConfigPath: *cfgPath, NoTUI: true}); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func runStop(args []string) {
	fs := flag.NewFlagSet("stop", flag.ExitOnError)
	cfgPath := fs.String("config", defaultConfig(), "connection config")
	shared := fs.Bool("shared", false, "also stop the global app-server/exec-server/proxy")
	_ = fs.Parse(args)
	cfg, err := app.LoadConfig(*cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	if err := app.ApplyGlobalPorts(cfg, app.RunDir()); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	log, _ := app.NewLogger("", true)
	if *shared {
		if err := app.StopAll(cfg, log); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
	} else if err := app.StopConfig(cfg, log); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func runTest(args []string) {
	fs := flag.NewFlagSet("test", flag.ExitOnError)
	cfgPath := fs.String("config", defaultConfig(), "connection config")
	pane := fs.String("pane", "TEST-PANE", "pane id")
	_ = fs.Parse(args)
	if err := app.SelfTest(*cfgPath, *pane); err != nil {
		fmt.Fprintln(os.Stderr, "FAIL:", err)
		os.Exit(1)
	}
}

func runToken(args []string) {
	fs := flag.NewFlagSet("token", flag.ExitOnError)
	cfgPath := fs.String("config", defaultConfig(), "connection config")
	pane := fs.String("pane", "manual-"+app.RandomHex(3), "pane id")
	envFile := fs.String("env-file", "", "write TOKEN=<value> to this file")
	_ = fs.Parse(args)
	cfg, err := app.LoadConfig(*cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	if err := app.ApplyGlobalPorts(cfg, app.RunDir()); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	tok, claims, err := app.IssueToken(cfg, *pane)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	if *envFile != "" {
		if err := os.WriteFile(*envFile, []byte("TOKEN="+tok+"\nENV_ID="+claims.EnvID+"\n"), 0o600); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
	}
	fmt.Println(tok)
}
