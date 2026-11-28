//go:build !windows

package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
)

func hiddenSysProc() *syscall.SysProcAttr {
	return nil
}

func ProcessImageName(pid int) string {
	if runtime.GOOS == "darwin" {
		out, err := exec.Command("ps", "-p", itoa(pid), "-o", "comm=").Output()
		if err != nil {
			return ""
		}
		return lower(filepath.Base(strings.TrimSpace(string(out))))
	}
	if exe, err := os.Readlink("/proc/" + itoa(pid) + "/exe"); err == nil {
		return lower(filepath.Base(exe))
	}
	data, err := os.ReadFile("/proc/" + itoa(pid) + "/comm")
	if err != nil {
		return ""
	}
	return lower(trimSpace(string(data)))
}

func ProcessCommandLine(pid int) string {
	if runtime.GOOS == "darwin" {
		out, err := exec.Command("ps", "-p", itoa(pid), "-o", "command=").Output()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(out))
	}
	data, err := os.ReadFile("/proc/" + itoa(pid) + "/cmdline")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(strings.ReplaceAll(string(data), "\x00", " "))
}

func KillPID(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	// StartDetached puts each managed service in its own process group. Kill
	// the group so the node wrapper and its native codex child go together.
	if err := syscall.Kill(-pid, syscall.SIGTERM); err == nil {
		return nil
	}
	return p.Signal(syscall.SIGTERM)
}

func PIDAlive(pid int) bool {
	return ProcessImageName(pid) != ""
}
