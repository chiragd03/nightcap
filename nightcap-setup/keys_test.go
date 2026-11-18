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

// To the Keys screen: Docker or Google Cloud Run, home or anywhere, a database that's fine.
func toKeysScreen(t *testing.T, where string, home bool) tea.Model {
	t.Helper()
	t.Setenv("TZ", "America/Toronto")
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir()) // (never this computer's own list)
	t.Setenv("NIGHTCAP_FILES_HOME", t.TempDir())
	lipgloss.SetColorProfile(termenv.TrueColor)
	lipgloss.SetHasDarkBackground(true)
	var m tea.Model = newApp()
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 40})
	for i, tl := range []tool{dockerOK, kubectlOK, gcloudOK} {
		m, _ = m.Update(checked{i, tl})
	}
	m = press(m, "enter") // Welcome
	switch where {
	case "docker":
		m = press(m, "enter") // (always at home: no question)
	case "files":
		m = press(m, "down", "down", "down", "enter")
		if home {
			m = press(m, "enter")
		} else {
			m = press(m, "down", "enter")
		}
	case "cloudrun":
		m = press(m, "down", "down", "enter")
		m, _ = m.Update(cloudChecked{cloudPlan{account: "me@example.com", project: "nightcap-test01", newProject: true, billing: "0A1B2C-000000-000000", region: "us-east1"}})
	}
	url := "postgresql://u:p@db.example.com:5432/nightcap"
	if where == "docker" || where == "files" {
		m = press(m, "down") // (past Make one for me)
	}
	if where != "cloudrun" { // (Google Cloud goes straight to the address)
		m = press(m, "enter")
	}
	m = press(m, url, "enter")
	m, _ = m.Update(dbChecked{url, dbReport{ok: true, version: "16", pgcrypto: "available", households: -1}})
	m = press(m, "enter")
	if s := m.(app).screen; s != keysScreenID {
		t.Fatalf("on screen %d, want Keys", s)
	}
	return m
}

// toKeysScreenWith is the Docker path with a pasted database whose check said [report].
func toKeysScreenWith(t *testing.T, report dbReport) tea.Model {
	where, home := "docker", true
	t.Helper()
	t.Setenv("TZ", "America/Toronto")
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir()) // (never this computer's own list)
	t.Setenv("NIGHTCAP_FILES_HOME", t.TempDir())
	lipgloss.SetColorProfile(termenv.TrueColor)
	lipgloss.SetHasDarkBackground(true)
	var m tea.Model = newApp()
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 40})
	for i, tl := range []tool{dockerOK, kubectlOK, gcloudOK} {
		m, _ = m.Update(checked{i, tl})
	}
	m = press(m, "enter") // Welcome
	switch where {
	case "docker":
		m = press(m, "enter") // (always at home: no question)
	case "files":
		m = press(m, "down", "down", "down", "enter")
		if home {
			m = press(m, "enter")
		} else {
			m = press(m, "down", "enter")
		}
	case "cloudrun":
		m = press(m, "down", "down", "enter")
		m, _ = m.Update(cloudChecked{cloudPlan{account: "me@example.com", project: "nightcap-test01", newProject: true, billing: "0A1B2C-000000-000000", region: "us-east1"}})
	}
	url := "postgresql://u:p@db.example.com:5432/nightcap"
	if where == "docker" || where == "files" {
		m = press(m, "down") // (past Make one for me)
	}
	if where != "cloudrun" { // (Google Cloud goes straight to the address)
		m = press(m, "enter")
	}
	m = press(m, url, "enter")
	m, _ = m.Update(dbChecked{url, report})
	m = press(m, "enter")
	return m
}

func snap(t *testing.T, m tea.Model, name string, secrets ...string) string {
	t.Helper()
	view := m.View()
	for _, s := range secrets {
		if s != "" && strings.Contains(view, s) {
			t.Errorf("%s: a secret is on screen", name)
		}
	}
	if h := lipgloss.Height(view); h > 40 {
		t.Errorf("%s: %d lines tall, in a 40-line window", name, h)
	}
	if w := lipgloss.Width(view); w > 100 {
		t.Errorf("%s: %d columns wide", name, w)
	}
	_ = os.WriteFile(filepath.Join("testdata", name+".ansi"), []byte(view), 0o644)
	return view
}

func TestKeysAndSettings(t *testing.T) {
	const tmdb = "0123456789abcdef0123456789abcdef"
	m := toKeysScreen(t, "docker", true)
	a := m.(app)
	secrets := []string{tmdb, a.keys.owner, a.keys.secrets}
	v := snap(t, m, "keys", secrets...)
	if !strings.Contains(v, "Paste your TMDB key") || strings.Contains(v, "Stream finder") || strings.Contains(v, "Owner key") {
		t.Error("the key's screen asks more than the key")
	}
	m = press(m, tmdb, "enter")
	if !m.(app).keys.checking {
		t.Fatal("Enter didn't check the key")
	}
	snap(t, m, "keys-checking", secrets...)
	m, _ = m.Update(tmdbChecked{key: tmdb, ok: false, why: "TMDB says this key isn't valid."})
	if v := snap(t, m, "keys-invalid", secrets...); !strings.Contains(v, "isn't valid") || m.(app).keys.stage != 0 {
		t.Error("a key that doesn't work: not said, or gone on")
	}
	// A key that works: on to the stream finder, its own question.
	m, _ = m.Update(tmdbChecked{key: tmdb, ok: true})
	v = snap(t, m, "keys-aio", secrets...)
	if m.(app).keys.stage != 1 || !strings.Contains(v, "Include a stream finder?") || !strings.Contains(v, "Recommended") {
		t.Fatal("a key that works didn't go on to the stream finder")
	}
	// Esc goes back to the key, Enter (it still works) forward again.
	m = press(m, "esc")
	if a := m.(app); a.screen != keysScreenID || a.keys.stage != 0 {
		t.Fatal("Esc didn't go back to the key")
	}
	m = press(m, "enter")
	// No stream finder.
	m = press(m, "down", "enter")
	a = m.(app)
	if a.screen != settingsScreenID || a.plan.keys.tmdb != tmdb || a.plan.keys.ownAIO || a.plan.keys.ownerKey == "" {
		t.Fatalf("after Keys: screen %d, keys %+v", a.screen, a.plan.keys.ownAIO)
	}
	// The name, then the country: one at a time.
	if v := snap(t, m, "settings", secrets...); !strings.Contains(v, "Name your server") || strings.Contains(v, "Country") {
		t.Error("the name's screen asks more than the name")
	}
	for range len("Nightcap") {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	}
	m = press(m, "enter")
	if v := snap(t, m, "settings-no-name", secrets...); m.(app).settings.stage != settingsName || !strings.Contains(v, "Give it a name.") {
		t.Error("no name went through")
	}
	m = press(m, "Home Cinema", "enter")
	if v := snap(t, m, "settings-country", secrets...); !strings.Contains(v, "Which country?") || !strings.Contains(v, "Canada") {
		t.Error("not on the country, or not Canada first (from this computer's time zone)")
	}
	m = press(m, "enter")
	a = m.(app)
	if a.screen != reviewScreenID || a.plan.settings.timezone != "America/Toronto" || a.plan.settings.country != "CA" || a.plan.settings.name != "Home Cinema" {
		t.Fatalf("after Settings: screen %d, %+v", a.screen, a.plan.settings)
	}
	v = snap(t, m, "review", secrets...)
	for _, want := range []string{"TMDB key", "works", "(households add their own)", "Home Cinema", "Canada", "America/Toronto", "Address"} {
		if !strings.Contains(v, want) {
			t.Errorf("the summary doesn't have %q", want)
		}
	}
}

func TestSettingsAnywhere(t *testing.T) {
	m := toKeysScreen(t, "files", false)
	m = press(m, "k", "enter")
	m, _ = m.Update(tmdbChecked{key: "k", ok: true})
	m = press(m, "enter", "enter", "enter") // the stream finder, the name, the country
	// Files for another machine, for people anywhere: its https:// address, asked.
	if a := m.(app); a.screen != settingsScreenID || a.settings.stage != settingsAddress {
		t.Fatal("not asked for the address")
	}
	m = press(m, "enter")
	if v := snap(t, m, "settings-anywhere-missing"); m.(app).screen != settingsScreenID || !strings.Contains(v, "https://") {
		t.Fatal("no address went through, for people anywhere")
	}
	m = press(m, "http://1.2.3.4", "enter")
	if m.(app).screen != settingsScreenID {
		t.Fatal("an http:// address went through, for people anywhere")
	}
	for range len("http://1.2.3.4") {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	}
	m = press(m, "https://tv.example.com/", "enter")
	if a := m.(app); a.screen != reviewScreenID || a.plan.settings.address != "https://tv.example.com" {
		t.Fatalf("screen %d, address %q", a.screen, a.plan.settings.address)
	}
}

func TestSettingsCloudRun(t *testing.T) {
	m := toKeysScreen(t, "cloudrun", false)
	m = press(m, "k", "enter")
	m, _ = m.Update(tmdbChecked{key: "k", ok: true})
	m = press(m, "enter", "enter", "enter") // the stream finder, the name, the country (no address: Google's)
	if a := m.(app); a.screen != reviewScreenID || a.plan.settings.address != "" {
		t.Fatalf("screen %d, address %q", a.screen, a.plan.settings.address)
	}
	if v := snap(t, m, "review-cloudrun"); !strings.Contains(v, "nightcap-test01") || !strings.Contains(v, "a month") {
		t.Error("Review doesn't show the project and the cost")
	}
	// Setting up: Google Cloud's own steps.
	var titles []string
	for _, st := range m.(app).reviewD.steps() {
		titles = append(titles, st.title)
	}
	if got := strings.Join(titles, ", "); got != "Checking Google Cloud, Getting the project ready, Turning on Cloud Run, Making the stream finder's database, Writing the files, Sending it to Google, Starting Nightcap, Checking it answers" {
		t.Errorf("steps: %s", got)
	}
}

// Against TMDB itself, when TMDB_TEST_KEY is a real key.
func TestRealTMDB(t *testing.T) {
	k := os.Getenv("TMDB_TEST_KEY")
	if k == "" {
		t.Skip("TMDB_TEST_KEY not set")
	}
	if r := checkTMDB(k); !r.ok {
		t.Errorf("a real key: %+v", r.why)
	}
	if r := checkTMDB("0000000000000000000000000000000"); r.ok || !strings.Contains(r.why, "isn't valid") {
		t.Errorf("a wrong key: %+v", r)
	}
}

// The server refuses an owner key shorter than 32 characters (owner.py's MIN_OWNER_KEY).
func TestOwnerKeyLongEnough(t *testing.T) {
	for range 50 {
		if k := ownerKey(); len(k) < 32 {
			t.Fatalf("owner key %d characters long", len(k))
		}
	}
}
