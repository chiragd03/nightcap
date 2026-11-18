package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// The owner API, as the server answers it: households, profiles and devices added up, versions.
func TestOwnerOf(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Owner-Key") != "KEY1-KEY2" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		switch r.URL.Path {
		case "/server/households.json":
			w.Write([]byte(`{"server":"Home","households":[{"profiles":3,"devices":2},{"profiles":2,"devices":1}]}`))
		case "/server/version.json":
			w.Write([]byte(`{"version":"1.0","latest":"1.1","update":true,"aiostreams":{"version":"2.38.0","tested":"2.37.0","ok":false}}`))
		}
	}))
	defer srv.Close()
	o, err := ownerOf(srv.URL, "KEY1-KEY2", 5*time.Second)
	if err != nil || o.households != 2 || o.profiles != 5 || o.devices != 3 || !o.update || o.latest != "1.1" || o.aioOK || o.aioTested != "2.37.0" {
		t.Fatalf("%+v %v", o, err)
	}
	if _, err := ownerOf(srv.URL, "wrong", 5*time.Second); err == nil {
		t.Error("a wrong key went through")
	}
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "secret.yaml"), []byte("stringData:\n  OWNER_KEY: \"AB12-CD34\"\n"), 0o600)
	if k := ownerKeyOf(dir); k != "AB12-CD34" {
		t.Errorf("owner key from secret.yaml: %q", k)
	}
	if bytesOf("412.5MiB") != 412.5*(1<<20) || bytesOf("128Mi") != 128*(1<<20) || sizeOf(1.5*(1<<30)) != "1.5 GB" {
		t.Error("sizes")
	}
}

// The server's screen: who's using it, versions, cost; the owner key only when asked; the logs
// coloured, errors only, searched.
func TestServerScreenExtras(t *testing.T) {
	s := savedServer{Name: "Cloud", Slug: "cloud", Where: "cloudrun", Mode: "cloud", Dir: t.TempDir(), Address: "https://cloud-1.a.run.app", Project: "nightcap-x", Region: "us-east1", Created: time.Now()}
	_ = os.WriteFile(filepath.Join(s.Dir, "nightcap.env"), []byte("OWNER_KEY=SECR-ETKE-Y123-4567\n"), 0o600)
	m := serverModel(t, s)
	m, _ = m.Update(tea.WindowSizeMsg{Width: 130, Height: 44})
	m, _ = m.Update(statusMsg{dir: s.Dir, st: serverStatus{parts: []part{{"server", "running", "healthy", 0}}, answers: true, name: "Cloud", mode: "cloud", households: -1}})
	if v := snapAt(t, m, "server-extras-waiting", 130, 44); !strings.Contains(v, "asking Google") || strings.Contains(v, "SECR-ETKE") {
		t.Error("while waiting: no word, or the key on screen")
	}
	m, _ = m.Update(extras{dir: s.Dir, owner: &ownerInfo{households: 2, profiles: 5, devices: 3, version: "1.0", latest: "1.1", update: true, hasAIO: true, aioVersion: "2.37.0", aioTested: "2.37.0", aioOK: true},
		cost: &cloudCost{soFar: 0.21, month: 0.9, cpuPct: 28, sentGiB: 2.5}})
	v := snapAt(t, m, "server-extras", 130, 44)
	for _, want := range []string{"2 households · 5 profiles · 3 devices", "1.1 is out: Update", "v2.37.0", "the tested one", "$0.21 so far · ~$0.90 this month",
		"Open owner page", "Show owner key", "Restart"} {
		if !strings.Contains(v, want) {
			t.Errorf("doesn't show %q", want)
		}
	}
	if strings.Contains(v, "SECR-ETKE") || strings.Contains(v, "Stop") {
		t.Error("the key on screen, or Stop on Google Cloud")
	}
	// A quiet look keeps them.
	m, _ = m.Update(statusMsg{dir: s.Dir, st: serverStatus{parts: []part{{"server", "running", "healthy", 0}}, answers: true, households: -1}, quiet: true})
	if v := m.View(); !strings.Contains(v, "$0.21 so far") {
		t.Error("a quiet look dropped the extras")
	}
	// Show owner key: on screen until hidden.
	sc := m.(app).server
	sc.act("key")
	if v := sc.View(120); !strings.Contains(v, "SECR-ETKE-Y123-4567") || !strings.Contains(v, "Hide owner key") {
		t.Error("Show owner key didn't show it")
	}
	sc.act("key")
	if strings.Contains(sc.View(120), "SECR-ETKE") {
		t.Error("Hide owner key didn't hide it")
	}

	// The logs: errors red, errors only with e, a search with /.
	m, _ = m.Update(logsMsg{text: "INFO started\nWARNING slow add-on HdHub\nERROR play failed: tt1\nINFO Play tt2: 3 verified\n"})
	m = press(m, "e")
	if v := snapAt(t, m, "server-logs-errors", 130, 44); strings.Contains(v, "INFO started") || !strings.Contains(v, "ERROR play failed") || !strings.Contains(v, "Errors and warnings only") {
		t.Error("errors only shows other lines")
	}
	m = press(m, "esc", "/", "HdHub")
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if v := snapAt(t, m, "server-logs-find", 130, 44); strings.Contains(v, "ERROR play failed") || !strings.Contains(v, "slow add-on HdHub") {
		t.Error("the search didn't keep only its lines")
	}
	m = press(m, "esc")
	if a := m.(app); !a.server.logs || a.server.search != "" {
		t.Error("Esc didn't drop the search first")
	}
	m = press(m, "esc")
	if m.(app).server.logs {
		t.Error("Esc didn't close the logs")
	}
}

// The list: each server in a line, as it answers.
func TestManageLines(t *testing.T) {
	s := savedServer{Name: "Home", Slug: "home", Where: "docker", Mode: "home", Dir: "/x/home", Address: "http://localhost:7171", Image: "img", Created: time.Now()}
	m := serverModel(t, s)
	m = press(m, "esc")
	if m.(app).screen != manageScreenID {
		t.Fatal("not on the list")
	}
	if v := m.View(); !strings.Contains(v, "looking…") {
		t.Error("no word while it looks")
	}
	m, _ = m.Update(serverLine{s.Dir, good.Render("● running") + "  ·  2 households"})
	if v := snap(t, m, "manage-lines"); !strings.Contains(v, "● running") || !strings.Contains(v, "2 households") {
		t.Error("the line isn't shown")
	}
}
