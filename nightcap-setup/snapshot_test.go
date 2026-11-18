package main

import (
	"os"
	"path/filepath"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// Screens drawn at a few window sizes, in colour, into testdata/ (to look at, and to turn into
// screenshots), after the keys a viewer would press. Run: go test ./...

var (
	dockerOK   = tool{name: "Docker", ok: true, ver: "27.3.1", detail: "ready"}
	dockerOff  = tool{name: "Docker", ver: "27.3.1", detail: "installed, but not running: start Docker"}
	kubectlOK  = tool{name: "kubectl", ok: true, ver: "1.31.2", detail: "cluster: k3s-home"}
	gcloudNone = tool{name: "gcloud", detail: "not installed", hint: "needed for Google Cloud"}
	gcloudOK   = tool{name: "gcloud", ok: true, ver: "555.0.0", detail: "ready"}
)

func press(m tea.Model, keys ...string) tea.Model {
	for _, k := range keys {
		var msg tea.KeyMsg
		switch k {
		case "enter":
			msg = tea.KeyMsg{Type: tea.KeyEnter}
		case "esc":
			msg = tea.KeyMsg{Type: tea.KeyEsc}
		case "down":
			msg = tea.KeyMsg{Type: tea.KeyDown}
		case "up":
			msg = tea.KeyMsg{Type: tea.KeyUp}
		default:
			msg = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)} // typed, or pasted
		}
		var cmd tea.Cmd
		m, cmd = m.Update(msg)
		// (Review is worked out a moment after the last answer: waited for, as the app would.)
		if a, ok := m.(app); ok && a.screen == settingsScreenID && a.settings.busy && cmd != nil {
			m, _ = m.Update(cmd())
		}
	}
	return m
}

func TestScreens(t *testing.T) {
	lipgloss.SetColorProfile(termenv.TrueColor)
	lipgloss.SetHasDarkBackground(true)
	if err := os.MkdirAll("testdata", 0o755); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name          string
		width, height int
		tools         []*tool // nil: still being checked
		keys          []string
		screen        screen
		plan          plan
	}{
		{"welcome-checking", 100, 30, []*tool{&dockerOK, nil, nil}, nil, welcomeScreen, plan{}},
		{"welcome", 100, 30, []*tool{&dockerOK, &kubectlOK, &gcloudNone}, nil, welcomeScreen, plan{}},
		{"welcome-big", 190, 50, []*tool{&dockerOK, &kubectlOK, &gcloudOK}, nil, welcomeScreen, plan{}},
		{"welcome-wide-short", 120, 30, []*tool{&dockerOK, &kubectlOK, &gcloudNone}, nil, welcomeScreen, plan{}},
		{"welcome-narrow", 60, 28, []*tool{&dockerOK, &kubectlOK, &gcloudNone}, nil, welcomeScreen, plan{}},
		{"where", 100, 34, []*tool{&dockerOK, &kubectlOK, &gcloudNone}, []string{"enter"}, whereScreen, plan{}},
		{"where-docker-off", 100, 34, []*tool{&dockerOff, &kubectlOK, &gcloudNone}, []string{"enter"}, whereScreen, plan{}},
		{"where-narrow", 60, 40, []*tool{&dockerOK, &kubectlOK, &gcloudNone}, []string{"enter"}, whereScreen, plan{}},
		// Down over gcloud's unusable choice goes on to Somewhere else.
		{"where-skips-unusable", 100, 34, []*tool{&dockerOK, &kubectlOK, &gcloudNone}, []string{"enter", "down", "down"}, whereScreen, plan{}},
		{"audience", 100, 30, []*tool{&dockerOK, &kubectlOK, &gcloudNone}, []string{"enter", "down", "down", "enter"}, audienceScreen, plan{where: "files"}},
		// Docker is for this home: no question.
		{"database-docker", 100, 30, []*tool{&dockerOK, &kubectlOK, &gcloudNone}, []string{"enter", "enter"}, databaseScreen, plan{where: "docker", mode: "home"}},
		{"cluster-k8s", 100, 30, []*tool{&dockerOK, &kubectlOK, &gcloudNone}, []string{"enter", "down", "enter"}, clusterScreenID, plan{where: "kubernetes", mode: "home"}},
		// Google Cloud Run is always for people anywhere: no question.
		{"cloud", 100, 36, []*tool{&dockerOK, &kubectlOK, &gcloudOK}, []string{"enter", "down", "down", "enter"}, cloudScreenID, plan{where: "cloudrun", mode: "cloud"}},
		{"back-to-where", 100, 34, []*tool{&dockerOK, &kubectlOK, &gcloudNone}, []string{"enter", "enter", "esc"}, whereScreen, plan{where: "docker", mode: "home"}},
	}
	for _, c := range cases {
		var m tea.Model = newApp()
		m, _ = m.Update(tea.WindowSizeMsg{Width: c.width, Height: c.height})
		for i, tl := range c.tools {
			if tl != nil {
				m, _ = m.Update(checked{i, *tl})
			}
		}
		m = press(m, c.keys...)
		got := m.(app)
		if got.screen != c.screen {
			t.Errorf("%s: on screen %d, want %d", c.name, got.screen, c.screen)
		}
		if got.plan != c.plan {
			t.Errorf("%s: plan %+v, want %+v", c.name, got.plan, c.plan)
		}
		if c.name == "where-skips-unusable" && got.where.cursor != 3 {
			t.Errorf("%s: cursor on %d, want 3 (Somewhere else)", c.name, got.where.cursor)
		}
		view := m.View()
		if w := lipgloss.Width(view); w > c.width {
			t.Errorf("%s: %d columns wide, in a %d-column window", c.name, w, c.width)
		}
		if h := lipgloss.Height(view); h > c.height {
			t.Errorf("%s: %d lines tall, in a %d-line window", c.name, h, c.height)
		}
		if err := os.WriteFile(filepath.Join("testdata", c.name+".ansi"), []byte(view), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// TestMain makes testdata/ (it's not kept in git) before any test draws into it.
func TestMain(m *testing.M) {
	_ = os.MkdirAll("testdata", 0o755)
	os.Exit(m.Run())
}
