package main

import (
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// In a small window (macOS Terminal's 80×24) every screen fits, and what's chosen stays in view.
func TestSmallWindow(t *testing.T) {
	m := toKeysScreen(t, "docker", true)
	m, _ = m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = press(m, "esc", "esc", "esc") // back to Where
	if v := snapAt(t, m, "small-where", 80, 24); !strings.Contains(v, "┃") {
		t.Error("Where: the chosen place isn't in view")
	}
	m = press(m, "down", "down", "down")
	if v := snapAt(t, m, "small-where-last", 80, 24); !strings.Contains(v, "┃") || !strings.Contains(v, "↑ more") {
		t.Error("Where: the last choice isn't scrolled to")
	}

	s := savedServer{Name: "Home", Slug: "home", Where: "docker", Mode: "home", Dir: "/x/home", Address: "http://localhost:7171", Image: "img", Created: time.Now()}
	sm := serverModel(t, s)
	sm, _ = sm.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	sm, _ = sm.Update(statusMsg{dir: s.Dir, st: serverStatus{parts: []part{{"db", "running", "healthy", 0}, {"aiostreams", "running", "healthy", 0}, {"server", "running", "healthy", 0}}, answers: true, households: 2}})
	sm = press(sm, "down", "down", "down", "down", "down", "down")
	if v := snapAt(t, sm, "small-server", 80, 24); !strings.Contains(v, "┃") {
		t.Error("Server: the chosen action isn't in view")
	}
}

func TestNewerVersion(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{{"v1.1.0", "1.0", true}, {"v1.10", "1.9", true}, {"1.0", "1.0.0", false}, {"v0.9", "1.0", false}, {"v1.0.1", "1.0", true}} {
		if newerVersion(c.a, c.b) != c.want {
			t.Errorf("newerVersion(%s, %s) != %v", c.a, c.b, c.want)
		}
	}
	m := serverModel(t, savedServer{Name: "H", Slug: "h", Where: "docker", Dir: "/x/h", Created: time.Now()})
	m, _ = m.Update(release{"1.2.0", "https://github.com/o/r/releases/tag/v1.2.0"})
	a := m.(app)
	a.screen = welcomeScreen
	if v := ansi.ReplaceAllString(a.View(), ""); !strings.Contains(v, "New version 1.2.0") {
		t.Error("no notice on Welcome")
	}
}

func TestReleaseVersion(t *testing.T) {
	for v, ok := range map[string]bool{"1.0.0": true, "1.2": false, "1.0.0-rc1": false, "v1.0": false, "1": false, "1.0.1-hotfix": false} {
		if releaseVersion.MatchString(v) != ok {
			t.Errorf("%s: %v", v, !ok)
		}
	}
}
