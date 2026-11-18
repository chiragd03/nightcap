package main

import (
	"errors"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func TestScrubKeepsAddresses(t *testing.T) {
	in := "start failed. Logs URL: https://console.cloud.google.com/logs?project=p · db postgresql://u:hunter2@h:5432/d password=s3cret&x=1"
	out := scrub(in)
	if !strings.Contains(out, "https://console.cloud.google.com/logs?project=p") {
		t.Errorf("an address was cut: %s", out)
	}
	if strings.Contains(out, "hunter2") || strings.Contains(out, "s3cret") || !strings.Contains(out, "postgresql://u:•••@h") {
		t.Errorf("a password shows: %s", out)
	}
}

func TestNamesFit(t *testing.T) {
	long := slugFor(strings.Repeat("my home cinema ", 10))
	if len(long) > 40 || strings.HasSuffix(long, "-") {
		t.Errorf("slug %q (%d)", long, len(long))
	}
	if n := cloudServiceName(long) + "-2"; len(n) > 49 {
		t.Errorf("Cloud Run name %d long", len(n))
	}
	if !strings.Contains(kubeSample("home", true).kubernetes(), "nodeSelector: {kubernetes.io/arch: amd64}") {
		t.Error("no nodeSelector for the amd64-only image")
	}
}

// TMDB not reachable from here: said, and Enter again uses the key as it is.
func TestTMDBUnreachable(t *testing.T) {
	m := toKeysScreen(t, "docker", true)
	m = press(m, "somekey", "enter")
	m, _ = m.Update(tmdbChecked{key: "somekey", why: "Couldn't reach TMDB from this computer. Press Enter again to use it anyway.", net: true})
	if a := m.(app); a.keys.stage != 0 {
		t.Fatal("went on without asking")
	}
	m = press(m, "enter")
	if a := m.(app); a.keys.stage != 1 || a.keys.checked != "somekey" {
		t.Error("Enter again didn't use it")
	}
}

// A failed Remove offers Try again, Forget it anyway, Go back; Forget takes it off the list only.
func TestRemoveFailedForget(t *testing.T) {
	s := savedServer{Name: "Gone", Slug: "gone", Where: "cloudrun", Mode: "cloud", Dir: "/x/gone", Project: "p", Region: "r", Created: time.Now()}
	m := serverModel(t, s)
	a := m.(app)
	a.remove = newRemoveScreen(s)
	a.screen, a.back = removeScreenID, append(a.back, serverScreenID)
	var mm tea.Model = a
	mm, _ = mm.Update(removed{err: errors.New("the project p wasn't found")})
	if v := snap(t, mm, "remove-failed"); !strings.Contains(v, "Forget it anyway") || !strings.Contains(v, "Try again") {
		t.Fatal("no way on after a failed Remove")
	}
	mm = press(mm, "down", "enter")
	if a := mm.(app); a.screen != manageScreenID || len(a.servers) != 0 || !strings.Contains(a.manageNote, "taken off the list") {
		t.Errorf("Forget it anyway: screen %d, %d servers", a.screen, len(a.servers))
	}
}

// One Nightcap per computer on Docker: with one on the list, Docker says so and can't be chosen.
func TestOneDockerServerPerComputer(t *testing.T) {
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	tools := []*tool{&dockerOK, &kubectlOK, &gcloudOK}
	if c := whereChoices(tools, 0); c.opts[0].why != "" {
		t.Fatal("Docker blocked with nothing on the list")
	}
	_ = saveServer(savedServer{Name: "Home", Slug: "home", Where: "docker", Dir: "/x/home", Created: time.Now()})
	c := whereChoices(tools, 0)
	if !strings.Contains(c.opts[0].why, "already runs one (Home)") || c.cursor == 0 {
		t.Errorf("Docker with one already: why %q, cursor %d", c.opts[0].why, c.cursor)
	}
}
