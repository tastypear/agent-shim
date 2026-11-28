//go:build !windows

package app

import (
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

var listenPIDRe = regexp.MustCompile(`pid=(\d+)`)

func PortPIDs(port int) []int {
	if port <= 0 {
		return nil
	}
	// Linux/WSL: ss is normally present and reports users:(("codex",pid=...)).
	if out, err := exec.Command("ss", "-ltnp").Output(); err == nil {
		needle := ":" + strconv.Itoa(port)
		var pids []int
		for _, line := range strings.Split(string(out), "\n") {
			if !strings.Contains(line, needle) {
				continue
			}
			for _, m := range listenPIDRe.FindAllStringSubmatch(line, -1) {
				pid, _ := strconv.Atoi(m[1])
				if pid > 0 {
					pids = append(pids, pid)
				}
			}
		}
		if len(pids) > 0 {
			return pids
		}
	}
	// macOS and minimal Unixes.
	if out, err := exec.Command("lsof", "-nP", "-iTCP:"+strconv.Itoa(port), "-sTCP:LISTEN", "-t").Output(); err == nil {
		var pids []int
		for _, field := range strings.Fields(string(out)) {
			pid, _ := strconv.Atoi(field)
			if pid > 0 {
				pids = append(pids, pid)
			}
		}
		return pids
	}
	return nil
}
