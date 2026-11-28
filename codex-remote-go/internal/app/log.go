package app

import (
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

type Logger struct {
	mu   sync.Mutex
	out  io.Writer
	file *os.File
	tee  bool
}

func NewLogger(path string, tee bool) (*Logger, error) {
	l := &Logger{tee: tee, out: os.Stderr}
	if path != "" {
		if err := os.MkdirAll(dirOf(path), 0o755); err != nil {
			return nil, err
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			return nil, err
		}
		l.file = f
		l.out = f
	}
	return l, nil
}

func dirOf(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' || p[i] == '\\' {
			return p[:i]
		}
	}
	return "."
}

func (l *Logger) Printf(format string, args ...any) {
	if l == nil {
		return
	}
	line := fmt.Sprintf("%s %s\n", time.Now().Format("15:04:05.000"), fmt.Sprintf(format, args...))
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = io.WriteString(l.out, line)
	if l.tee && l.file != nil {
		_, _ = io.WriteString(os.Stderr, line)
	}
}

func (l *Logger) Close() error {
	if l == nil || l.file == nil {
		return nil
	}
	return l.file.Close()
}

func (l *Logger) Path() string {
	if l == nil || l.file == nil {
		return ""
	}
	return l.file.Name()
}
