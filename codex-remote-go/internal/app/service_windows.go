//go:build windows

package app

import (
	"fmt"
	"os/exec"
)

func PortPIDs(port int) []int {
	if port <= 0 {
		return nil
	}
	cmd := exec.Command("netstat", "-ano", "-p", "TCP")
	cmd.SysProcAttr = hiddenSysProc()
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	return parseNetstatPIDs(string(out), port)
}

func parseNetstatPIDs(out string, port int) []int {
	suffix := fmt.Sprintf(":%d", port)
	var pids []int
	for _, line := range splitLines(out) {
		fields := splitFields(line)
		if len(fields) < 5 {
			continue
		}
		if !hasSuffix(fields[1], suffix) {
			continue
		}
		if fields[3] != "LISTENING" {
			continue
		}
		var pid int
		if _, err := fmt.Sscanf(fields[4], "%d", &pid); err == nil && pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}
