//go:build windows

package app

import "syscall"

// The TUI must keep the caller's console (it is an interactive TUI).
func tuiSysProc() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{}
}
