//go:build windows

package app

import (
	"fmt"
	"os/exec"
	"syscall"
)

func hiddenSysProc() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

func ProcessImageName(pid int) string {
	cmd := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/FO", "CSV", "/NH")
	cmd.SysProcAttr = hiddenSysProc()
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	s := string(out)
	if len(s) == 0 || s[0] != '"' {
		return ""
	}
	end := 1
	for end < len(s) && s[end] != '"' {
		end++
	}
	return lower(s[1:end])
}

func ProcessCommandLine(pid int) string {
	return ""
}

func KillPID(pid int) error {
	cmd := exec.Command("taskkill", "/PID", fmt.Sprintf("%d", pid), "/F")
	cmd.SysProcAttr = hiddenSysProc()
	return cmd.Run()
}

func PIDAlive(pid int) bool {
	return ProcessImageName(pid) != ""
}
