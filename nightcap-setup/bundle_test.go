package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func samplePlan(where, mode string, db bool) plan {
	p := plan{where: where, mode: mode,
		keys:     keysPlan{tmdb: "tmdbkey0123456789", ownAIO: true, ownerKey: "AAAA-BBBB-CCCC-DDDD", secretsKey: "secretsecretsecretsecret"},
		settings: settingsPlan{name: "Nightcap at Home", country: "CA", timezone: "America/Toronto"}}
	if mode == "cloud" {
		p.settings.address = "https://tv.example.com"
	}
	if db {
		d := dockerDB{name: "db", volume: "db-data", image: dbImage, port: 55432, password: "dbpass123456"}
		p.db = connPlan{where: "Postgres in Docker, alongside", docker: &d}
	} else {
		p.db = connPlan{url: "postgresql://u:p%23w@db.example.com:5432/nightcap", where: "db.example.com:5432/nightcap"}
	}
	return p
}

func TestBundleHomeLinux(t *testing.T) {
	b := makeBundle(samplePlan("files", "home", true), true)
	c := b.compose()
	for _, want := range []string{"name: nightcap-at-home", "network_mode: host", "127.0.0.1:55432:5432", "127.0.0.1:3000:3000",
		"condition: service_healthy", "platform: linux/amd64", "db-data:", "aiostreams-data:"} {
		if !strings.Contains(c, want) {
			t.Errorf("compose hasn't %q", want)
		}
	}
	env := envFile("", b.serverEnv())
	for _, want := range []string{"MODE=home", "DATABASE_URL=postgresql://nightcap:dbpass123456@127.0.0.1:55432/nightcap?sslmode=disable",
		"SERVER_NAME='Nightcap at Home'", "OWNER_KEY=AAAA-BBBB-CCCC-DDDD"} {
		if !strings.Contains(env, want) {
			t.Errorf("nightcap.env hasn't %q:\n%s", want, env)
		}
	}
	// Its own stream finder's address is a setting.
	if !strings.Contains(env, "OWN_AIOSTREAMS_URL=http://127.0.0.1:3000") || strings.Contains(b.readme(), "stream-finder.sql") {
		t.Errorf("stream finder:\n%s", env)
	}
	// A home server refuses to start with a public address.
	if strings.Contains(env, "PUBLIC_URL") {
		t.Error("a home server is given PUBLIC_URL")
	}
	// No key in the files anyone can read.
	for _, secret := range []string{"tmdbkey0123456789", "secretsecretsecretsecret", "dbpass123456", b.aioKey} {
		if strings.Contains(c, secret) || strings.Contains(b.readme(), secret) {
			t.Errorf("a key is in docker-compose.yml or the README")
		}
	}
	// The server makes its own tables: no step for them.
	if strings.Contains(c, "schema") {
		t.Error("compose still has a step making the tables")
	}
}

func TestBundleDockerDesktop(t *testing.T) {
	b := makeBundle(samplePlan("docker", "home", true), false)
	c := b.compose()
	if strings.Contains(c, "network_mode: host") || !strings.Contains(c, `"7171:7171"`) {
		t.Error("on Docker Desktop the server's port should be published, not on the host's network")
	}
	env := envFile("", b.serverEnv())
	if !strings.Contains(env, "@db:5432/") || b.ownAIOAddress() != "http://aiostreams:3000" {
		t.Errorf("not reached on Compose's network:\n%s", env)
	}
}

func TestBundleAnywhereOwnDatabase(t *testing.T) {
	b := makeBundle(samplePlan("files", "cloud", false), true)
	c, env := b.compose(), envFile("", b.serverEnv())
	if strings.Contains(c, "  db:") || strings.Contains(c, "network_mode: host") {
		t.Error("people anywhere, with a database of their own: no db service, not on the host's network")
	}
	if !strings.Contains(env, "PUBLIC_URL=https://tv.example.com") || !strings.Contains(env, "MODE=cloud") ||
		!strings.Contains(env, "DATABASE_URL=postgresql://u:p%23w@db.example.com:5432/nightcap") {
		t.Errorf("nightcap.env:\n%s", env)
	}
}

func TestBundleWrite(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "srv")
	b := makeBundle(samplePlan("files", "home", true), true)
	if err := b.write(dir); err != nil {
		t.Fatal(err)
	}
	for name, mode := range map[string]os.FileMode{"docker-compose.yml": 0o644, "nightcap.env": 0o600, ".env": 0o600, "README.md": 0o644} {
		st, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != mode {
			t.Errorf("%s: mode %v, want %v", name, st.Mode().Perm(), mode)
		}
	}
}

func TestQuoteEnv(t *testing.T) {
	for in, want := range map[string]string{"plain": "plain", "two words": "'two words'", "a$b": "'a$b'", "it's": `"it's"`, "": "''"} {
		if got := quoteEnv(in); got != want {
			t.Errorf("quoteEnv(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestReviewDeployDone(t *testing.T) {
	m := toKeysScreen(t, "docker", true)
	m = press(m, "k", "enter")
	m, _ = m.Update(tmdbChecked{key: "k", ok: true})
	m = press(m, "enter", "enter", "enter") // the stream finder, the name, the country
	if m.(app).screen != reviewScreenID {
		t.Fatal("not on Review")
	}
	v := snap(t, m, "review")
	if !strings.Contains(v, "Files") || !strings.Contains(v, "nightcap") || !strings.Contains(v, "Set it up") {
		t.Error("Review doesn't say where the files go, or how to set it up")
	}
	// The deploy screen, as its steps report (the deploy itself isn't run here).
	a := m.(app)
	a.deploy = newDeployScreen(a.plan)
	a.screen = deployScreenID
	m = a
	m, _ = m.Update(deployMsg{step: 0, state: done, note: "Compose v2.40"})
	m, _ = m.Update(deployMsg{step: 1, state: done, note: "~/.nightcap-setup/servers/nightcap"})
	m, _ = m.Update(deployMsg{step: 2, state: running, line: "server Pulling"})
	snap(t, m, "deploy-running")
	m, _ = m.Update(deployMsg{step: 2, state: failed, err: os.ErrPermission, line: "✗ denied"})
	if v := snap(t, m, "deploy-failed"); !strings.Contains(v, "Try again") || !strings.Contains(v, "Go back") {
		t.Error("a failed step doesn't offer to try again")
	}
	a = m.(app)
	a.deploy.err = nil
	for i := range a.deploy.steps {
		a.deploy.steps[i].state = done
	}
	m = a
	m, _ = m.Update(deployMsg{step: -1, end: true})
	m = press(m, "enter")
	if m.(app).screen != doneScreenID {
		t.Fatal("not on Done after it's all done")
	}
	if v := snap(t, m, "done"); !strings.Contains(v, "Nightcap is running") || !strings.Contains(v, m.(app).plan.keys.ownerKey) {
		t.Error("Done doesn't say it's running, or show the owner key")
	}
	_ = tea.Quit
}
