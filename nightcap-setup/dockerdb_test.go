package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

func TestDockerDBScreens(t *testing.T) {
	lipgloss.SetColorProfile(termenv.TrueColor)
	lipgloss.SetHasDarkBackground(true)
	planned := dockerDB{name: "db", volume: "db-data", image: dbImage, port: 55432, password: "Secret123"}

	var m tea.Model = newApp()
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 34})
	for i, tl := range []tool{dockerOK, kubectlOK, gcloudNone} {
		m, _ = m.Update(checked{i, tl})
	}
	m = press(m, "enter", "enter", "enter") // Welcome, Docker, Make one for me
	if got := m.(app).screen; got != dockerDBScreenID {
		t.Fatalf("on screen %d, want the Postgres in Docker one", got)
	}
	write := func(name string) {
		view := m.View()
		if strings.Contains(view, "Secret123") {
			t.Errorf("%s: the password is on screen", name)
		}
		if h := lipgloss.Height(view); h > 34 {
			t.Errorf("%s: %d lines tall", name, h)
		}
		_ = os.WriteFile(filepath.Join("testdata", name+".ansi"), []byte(view), 0o644)
	}
	write("dockerdb-looking")
	m, _ = m.Update(dockerDBPlanned{db: planned})
	write("dockerdb")
	m, _ = m.Update(tea.WindowSizeMsg{Width: 60, Height: 34})
	write("dockerdb-narrow")
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 34})
	m = press(m, "enter")
	got := m.(app)
	if got.screen != keysScreenID || got.plan.db.docker == nil || got.plan.db.docker.password != "Secret123" {
		t.Fatalf("after Use this: screen %d, plan %+v", got.screen, got.plan.db.where)
	}
	write("keys-after-dockerdb")
}
