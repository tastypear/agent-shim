//go:build !windows

package app

import (
	"os"
	"os/exec"
	"syscall"
)

func StartDetached(argv []string, env map[string]string, logPath string) (int, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	if env != nil {
		cmd.Env = envSlice(env)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if logPath != "" {
		f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			return 0, err
		}
		cmd.Stdout = f
		cmd.Stderr = f
		defer f.Close()
	}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	return pid, nil
}

func envSlice(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

func EnvironMap() map[string]string {
	out := map[string]string{}
	for _, kv := range os.Environ() {
		k, v, ok := splitEnv(kv)
		if ok {
			out[k] = v
		}
	}
	return out
}
