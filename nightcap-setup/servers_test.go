package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func TestSavedServers(t *testing.T) {
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	if list, err := loadServers(); err != nil || len(list) != 0 {
		t.Fatalf("a fresh list: %v %v", list, err)
	}
	a := savedServer{Name: "Home", Slug: "home", Where: "docker", Mode: "home", Dir: "/x/home", Created: time.Now().Add(-time.Hour)}
	b := savedServer{Name: "Cabin", Slug: "cabin", Where: "files", Mode: "cloud", Dir: "/x/cabin", Created: time.Now()}
	for _, s := range []savedServer{a, b} {
		if err := saveServer(s); err != nil {
			t.Fatal(err)
		}
	}
	list, _ := loadServers()
	if len(list) != 2 || list[0].Name != "Cabin" {
		t.Fatalf("newest first: %+v", list)
	}
	// The same folder again replaces it.
	a.Name = "Home again"
	_ = saveServer(a)
	list, _ = loadServers()
	if len(list) != 2 {
		t.Fatalf("saving one again added another: %d", len(list))
	}
	if st, _ := os.Stat(serversFile()); st.Mode().Perm() != 0o600 {
		t.Errorf("servers.json mode %v, want 0600", st.Mode().Perm())
	}
}

func TestUniqueSlug(t *testing.T) {
	dir := t.TempDir()
	dirFor := func(s string) string { return filepath.Join(dir, s) }
	if got := uniqueSlug("home", dirFor, nil); got != "home" {
		t.Errorf("free: %q", got)
	}
	_ = os.Mkdir(dirFor("home"), 0o700)
	if got := uniqueSlug("home", dirFor, nil); got != "home-2" {
		t.Errorf("folder taken: %q", got)
	}
	if got := uniqueSlug("home", dirFor, map[string]bool{"home-2": true}); got != "home-3" {
		t.Errorf("folder and name taken: %q", got)
	}
}

// A setup that finishes is saved in the list, with no keys; Manage lists it.
func TestSetupIsSaved(t *testing.T) {
	m := toKeysScreen(t, "docker", true)
	m = press(m, "k", "enter")
	m, _ = m.Update(tmdbChecked{key: "k", ok: true})
	m = press(m, "enter", "enter", "enter") // the stream finder, the name, the country
	a := m.(app)
	if a.reviewD == nil {
		t.Fatal("Review didn't work out the server's name and folder")
	}
	a.deploy = deployScreenFor(a.reviewD)
	a.screen = deployScreenID
	m = a
	m, _ = m.Update(deployMsg{step: -1, end: true})
	if err := m.(app).deploy.saveErr; err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(serversFile())
	// (The test's TMDB key is one letter; these two are long and made here.)
	for _, secret := range []string{a.plan.keys.ownerKey, a.plan.keys.secretsKey} {
		if strings.Contains(string(data), secret) {
			t.Error("a key is in servers.json")
		}
	}
	list, _ := loadServers()
	if len(list) != 1 || list[0].Name != "Nightcap" || list[0].Where != "docker" || !strings.HasSuffix(list[0].Dir, "/servers/nightcap") {
		t.Fatalf("saved: %+v", list)
	}
	// Manage, from the start.
	var w tea.Model = newApp()
	w, _ = w.Update(tea.WindowSizeMsg{Width: 100, Height: 34})
	w = press(w, "down", "enter")
	if w.(app).screen != manageScreenID {
		t.Fatal("not on Manage")
	}
	v := snap(t, w, "manage", a.plan.keys.ownerKey)
	for _, want := range []string{"Your servers", "Nightcap", "On this computer", "looking…"} {
		if !strings.Contains(v, want) {
			t.Errorf("Manage doesn't show %q", want)
		}
	}
	w = press(w, "enter")
	if w.(app).screen != serverScreenID || w.(app).server.s.Name != "Nightcap" {
		t.Error("choosing a server doesn't open its screen")
	}
}

func TestManageEmpty(t *testing.T) {
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	var m tea.Model = newApp()
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = press(m, "down", "enter")
	if !strings.Contains(snap(t, m, "manage-empty"), "None yet") {
		t.Error("an empty list says nothing")
	}
}
