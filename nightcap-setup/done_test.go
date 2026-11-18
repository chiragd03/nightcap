package main

import (
	"errors"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// Done says how TVs join for this setup: by invite (people anywhere), by typing the address
// (Docker Desktop), or by picking it (found on the Wi-Fi); and another machine's address isn't this one's.
func TestDoneSaysWhatsTrue(t *testing.T) {
	keys := keysPlan{ownerKey: "AAAA-BBBB"}
	cases := []struct {
		name string
		p    plan
		d    *deployer
		want []string
		not  string
	}{
		{"anywhere", plan{mode: "cloud", keys: keys}, &deployer{here: true, cloud: true, cloudURL: "https://x.run.app"}, []string{"make an invite", "Settings, Household, Invites", "open its invite in this browser", "https://x.run.app/app/server"}, "pick this server"},
		{"docker desktop", plan{mode: "home", keys: keys}, &deployer{here: true, b: bundle{hostNet: false}}, []string{"type its address", "http://localhost:7171/app/server", "http://<this computer's address>:7171"}, "pick this server"},
		{"linux docker", plan{mode: "home", keys: keys}, &deployer{here: true, b: bundle{hostNet: true}}, []string{"pick this server", "on your Wi-Fi find it", "on Samsung and LG, type its address"}, "install Nightcap and type"},
		{"another machine", plan{mode: "home", keys: keys}, &deployer{b: bundle{hostNet: true}}, []string{"<that machine's address>"}, "localhost"},
	}
	for _, c := range cases {
		v := strings.Join(strings.Fields(ansi.ReplaceAllString(doneView(c.p, c.d, 90, doneChoices(c.d)), "")), " ") // (as read: lines joined)
		for _, w := range c.want {
			if !strings.Contains(v, w) {
				t.Errorf("%s: doesn't say %q", c.name, w)
			}
		}
		if strings.Contains(v, c.not) {
			t.Errorf("%s: says %q", c.name, c.not)
		}
	}
	if c := doneChoices(&deployer{here: true}); c.opts[0].value != "manage" {
		t.Error("Done doesn't offer this server's screen")
	}
	if c := doneChoices(&deployer{}); len(c.opts) != 1 || c.opts[0].value != "quit" {
		t.Error("files for another machine offered Manage")
	}
}

// The database made for you: a failure to look offers Try again and Choose something else.
func TestDockerDBFailureWayOn(t *testing.T) {
	m := toKeysScreen(t, "docker", true)
	m = press(m, "esc", "esc") // (back to the database's kind)
	m = press(m, "up", "enter")
	m, _ = m.Update(dockerDBPlanned{err: errors.New("docker didn't answer")})
	v := snap(t, m, "dockerdb-failed")
	if !strings.Contains(v, "Try again") || !strings.Contains(v, "Choose something else") || !strings.Contains(v, "Couldn't look at this computer") {
		t.Error("no way on after a failure")
	}
}

// Where keeps to the Recommended choice when a check lands late, unless the user moved.
func TestWhereCursorKeepsRecommended(t *testing.T) {
	var m tea.Model = newApp()
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 40})
	m = press(m, "enter") // (Where, before any check is back)
	for i, tl := range []tool{dockerOK, kubectlOK, gcloudOK} {
		m, _ = m.Update(checked{i, tl})
	}
	if c := m.(app).where.cursor; c != 0 {
		t.Errorf("cursor on %d after the checks, want 0 (This computer)", c)
	}
}

// An empty Manage offers to set one up.
func TestEmptyManageOffersSetup(t *testing.T) {
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	var m tea.Model = newApp()
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 40})
	m = press(m, "down", "enter")
	if v := snap(t, m, "manage-empty"); !strings.Contains(v, "Set up a new server") {
		t.Fatal("an empty list doesn't offer a setup")
	}
	m = press(m, "enter")
	if m.(app).screen != whereScreen {
		t.Error("Set up a new server didn't go to Where")
	}
}

// The shared spinner keeps turning after screens with their own (a server's, setting up, Remove):
// its tick always gets its next one.
func TestSharedSpinnerKeepsTurning(t *testing.T) {
	s := savedServer{Name: "Home", Slug: "home", Where: "docker", Mode: "home", Dir: "/x/home", Created: time.Now()}
	m := serverModel(t, s)
	a := m.(app)
	tick := a.welcome.spin.Tick()
	if _, cmd := m.Update(tick); cmd == nil {
		t.Error("on a server's screen, the shared spinner's tick was swallowed")
	}
	a.screen = deployScreenID
	var mm tea.Model = a
	if _, cmd := mm.Update(tick); cmd == nil {
		t.Error("while setting up, the shared spinner's tick was swallowed")
	}
}
