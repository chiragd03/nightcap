package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// The wide frame (the setup steps down the left, a server's screen side by side), a light
// terminal, and a server's screen looking again of its own accord.

func snapAt(t *testing.T, m tea.Model, name string, width, height int) string {
	t.Helper()
	view := m.View()
	if w := lipgloss.Width(view); w > width {
		t.Errorf("%s: %d columns wide, in a %d-column window", name, w, width)
	}
	if h := lipgloss.Height(view); h > height {
		t.Errorf("%s: %d lines tall, in a %d-line window", name, h, height)
	}
	_ = os.WriteFile(filepath.Join("testdata", name+".ansi"), []byte(view), 0o644)
	return view
}

func wideApp(width, height int) tea.Model {
	var m tea.Model = newApp()
	m, _ = m.Update(tea.WindowSizeMsg{Width: width, Height: height})
	for i, tl := range []tool{dockerOK, kubectlOK, gcloudNone} {
		m, _ = m.Update(checked{i, tl})
	}
	return m
}

func TestWideSetup(t *testing.T) {
	lipgloss.SetColorProfile(termenv.TrueColor)
	lipgloss.SetHasDarkBackground(true)
	m := press(wideApp(130, 40), "enter")
	v := snapAt(t, m, "where-wide", 130, 40)
	if !strings.Contains(v, "SETUP") || !strings.Contains(v, "Where should Nightcap run?") {
		t.Error("the wide frame has no steps column")
	}
	m = press(m, "enter") // Docker (at home)
	v = snapAt(t, m, "database-wide", 130, 40)
	if !strings.Contains(v, "This computer") {
		t.Error("the steps column doesn't say what was chosen")
	}
	// A narrower window keeps the tracker across the top.
	m, _ = m.Update(tea.WindowSizeMsg{Width: 99, Height: 34})
	if v := m.View(); strings.Contains(v, "SETUP") || !strings.Contains(v, "Database") {
		t.Error("a 99-column window got the wide frame")
	}

	lipgloss.SetHasDarkBackground(false)
	defer lipgloss.SetHasDarkBackground(true)
	m, _ = m.Update(tea.WindowSizeMsg{Width: 130, Height: 40})
	snapAt(t, m, "database-wide-light", 130, 40)
}

func TestServerScreenWideAndLive(t *testing.T) {
	s := savedServer{Name: "Home", Slug: "home", Where: "docker", Mode: "home", Dir: "/x/home", Address: "http://localhost:7171", Image: "img", Created: time.Now()}
	m := serverModel(t, s)
	m, _ = m.Update(tea.WindowSizeMsg{Width: 130, Height: 40})
	var cmd tea.Cmd
	m, cmd = m.Update(statusMsg{dir: s.Dir, st: serverStatus{parts: []part{{"db", "running", "healthy", 0}, {"aiostreams", "running", "healthy", 0}, {"server", "running", "healthy", 0}},
		answers: true, name: "Home", mode: "home", households: 2, newer: "yes"}})
	if cmd == nil {
		t.Error("no next look after a look")
	}
	v := snapAt(t, m, "server-wide", 130, 40)
	for _, want := range []string{"What to do", "live", "2 households", "Stop"} {
		if !strings.Contains(v, want) {
			t.Errorf("the wide server screen doesn't show %q", want)
		}
	}

	// The round's own tick looks again; one of an older round doesn't.
	gen := m.(app).server.gen
	if _, c := m.Update(liveTick{s.Dir, gen - 1}); c != nil {
		t.Error("an old round's tick looked again")
	}
	m, cmd = m.Update(liveTick{s.Dir, gen})
	if cmd == nil || !m.(app).server.quiet {
		t.Error("the tick didn't look again")
	}
	// A quiet look keeps what the registry said, and doesn't blank the screen meanwhile.
	if v := m.View(); !strings.Contains(v, "checking…") || !strings.Contains(v, "Database") {
		t.Error("a quiet look blanked the status")
	}
	m, _ = m.Update(statusMsg{dir: s.Dir, st: serverStatus{parts: []part{{"server", "stopping", "", 0}}, answerErr: "it answered 500"}, quiet: true})
	if a := m.(app); a.server.st.newer != "yes" || a.server.quiet || a.server.running() {
		t.Errorf("after a quiet look: newer %q, quiet %v, running %v", a.server.st.newer, a.server.quiet, a.server.running())
	}

	// The logs follow: new lines show when it's at the bottom.
	m, _ = m.Update(logsMsg{text: "INFO started\n"})
	m, _ = m.Update(logsMsg{text: "INFO started\nINFO Play tt9: 2 verified\n", follow: true})
	v = snapAt(t, m, "server-logs-wide", 130, 40)
	if !strings.Contains(v, "Play tt9") || !strings.Contains(v, "● live") {
		t.Error("the logs didn't follow")
	}

	lipgloss.SetHasDarkBackground(false)
	defer lipgloss.SetHasDarkBackground(true)
	m = press(m, "esc")
	snapAt(t, m, "server-wide-light", 130, 40)
}

func TestWelcomeAnimates(t *testing.T) {
	lipgloss.SetColorProfile(termenv.TrueColor)
	lipgloss.SetHasDarkBackground(true)
	m := wideApp(190, 50)
	first := m.View()
	for range 20 {
		m, _ = m.Update(animTick{0})
	}
	if v := snapAt(t, m, "welcome-shine", 190, 50); v == first || !strings.Contains(v, "☾") {
		t.Error("Welcome didn't move, or has no moon")
	}
	// On another screen its frames are let go; back on Welcome they start again.
	m = press(m, "enter")
	if _, cmd := m.Update(animTick{0}); cmd != nil {
		t.Error("the animation kept going on another screen")
	}
	m = press(m, "esc")
	if a := m.(app); a.screen != welcomeScreen || a.welcome.animGen != 1 {
		t.Error("back on Welcome, the animation didn't start again")
	}
}
