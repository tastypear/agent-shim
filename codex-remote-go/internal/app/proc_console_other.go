//go:build !windows

package app

import "syscall"

func tuiSysProc() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{}
}
