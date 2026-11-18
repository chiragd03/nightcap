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

func TestNormalizeURL(t *testing.T) {
	for in, want := range map[string]string{
		"postgresql://sa:Pass#word1@192.168.1.20:30432/nightcap": "postgresql://sa:Pass%23word1@192.168.1.20:30432/nightcap",
		"postgres://u:p%23x@h/db":                                "postgres://u:p%23x@h/db",
		"postgresql://u:a@b@h:5432/db":                           "postgresql://u:a%40b@h:5432/db",
		"u:p@h/db":                                               "postgresql://u:p@h/db",
		"postgresql://h/db":                                      "postgresql://h/db",
		"  postgresql://u@h/db  ":                                "postgresql://u@h/db",
	} {
		if got := normalizeURL(in); got != want {
			t.Errorf("normalizeURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMaskAndWhere(t *testing.T) {
	in := "postgresql://sa:Pass#word1@db.example.com:5432/nightcap"
	masked := maskURL(in)
	if strings.Contains(masked, "Pass") || len([]rune(masked)) != len([]rune(in)) {
		t.Errorf("maskURL(%q) = %q", in, masked)
	}
	if got := dbWhere(in); got != "db.example.com:5432/nightcap" {
		t.Errorf("dbWhere = %q", got)
	}
	if got := scrub("failed to connect to postgresql://sa:secret@h"); strings.Contains(got, "secret") {
		t.Errorf("scrub left the password in: %q", got)
	}
}

func TestDatabaseScreens(t *testing.T) {
	lipgloss.SetColorProfile(termenv.TrueColor)
	lipgloss.SetHasDarkBackground(true)
	url := "postgresql://nightcap:Pass#word1@db.example.com:5432/nightcap"
	fresh := dbReport{ok: true, version: "16.4", pgcrypto: "available", households: -1}
	existing := dbReport{ok: true, version: "15.8", pgcrypto: "installed", households: 2, profiles: 7, others: 3}
	wrong := dbReport{households: -1, problem: "The database said the user or password is wrong.", advice: "Check the password, and that this user may connect."}
	cases := []struct {
		name   string
		report *dbReport
		after  []string
		screen screen
	}{
		{"conn-empty", nil, nil, connScreen},
		{"conn-typed", nil, []string{url}, connScreen},
		{"conn-ok", &fresh, []string{url}, connScreen},
		{"conn-existing", &existing, []string{url}, connScreen},
		{"conn-wrong", &wrong, []string{url}, connScreen},
		{"keys-after-db", &fresh, []string{url}, keysScreenID},
	}
	for _, c := range cases {
		var m tea.Model = newApp()
		m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 34})
		for i, tl := range []tool{dockerOK, kubectlOK, gcloudNone} {
			m, _ = m.Update(checked{i, tl})
		}
		m = press(m, "enter", "enter", "down", "enter") // Welcome, Docker, I already have one
		m = press(m, c.after...)
		if c.report != nil {
			m, _ = m.Update(dbChecked{url, *c.report})
			if c.screen == keysScreenID {
				m = press(m, "enter")
			}
		}
		got := m.(app)
		if got.screen != c.screen {
			t.Errorf("%s: on screen %d, want %d", c.name, got.screen, c.screen)
		}
		view := m.View()
		if strings.Contains(view, "Pass#word1") || strings.Contains(view, "Pass%23word1") {
			t.Errorf("%s: the password is on screen", c.name)
		}
		if c.screen == keysScreenID {
			if got.plan.db.url != normalizeURL(url) || got.plan.db.where != "db.example.com:5432/nightcap" {
				t.Errorf("%s: database plan %+v", c.name, got.plan.db.where)
			}
		}
		if h := lipgloss.Height(view); h > 34 {
			t.Errorf("%s: %d lines tall, in a 34-line window", c.name, h)
		}
		if err := os.WriteFile(filepath.Join("testdata", c.name+".ansi"), []byte(view), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}
