package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// What runs is what the screen lists: each setup's steps, in a dry run (titles only, nothing done).
func TestStepsRunAsListed(t *testing.T) {
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	for _, where := range []string{"kubernetes", "cloudrun"} {
		for _, own := range []bool{true, false} {
			p := samplePlan(where, "home", true)
			if where == "cloudrun" {
				p = cloudSample(own).plan
			}
			p.keys.ownAIO = own
			d := &deployer{here: true, kube: where == "kubernetes", cloud: where == "cloudrun", dir: t.TempDir(), b: bundle{plan: p, slug: "t"},
				out: make(chan deployMsg, 100)}
			var ran []string
			step := func(title string, _ func() (string, error)) bool { ran = append(ran, title); return true }
			if d.cloud {
				d.runCloud(context.Background(), step)
			} else {
				d.runKube(context.Background(), step)
			}
			var listed []string
			for _, s := range d.steps() {
				listed = append(listed, s.title)
			}
			if strings.Join(ran, " / ") != strings.Join(listed, " / ") {
				t.Errorf("%s (own stream finder %v):\n ran    %s\n listed %s", where, own, strings.Join(ran, " / "), strings.Join(listed, " / "))
			}
		}
	}
}

func TestUnquoteEnv(t *testing.T) {
	for _, raw := range []string{"plain", "with space", "it's $x \"q\"", ""} {
		if got := unquoteEnv(quoteEnv(raw)); got != raw {
			t.Errorf("%q → %q → %q", raw, quoteEnv(raw), got)
		}
	}
	if err := putTemplate(savedServer{Where: "files", OwnAIO: "http://aiostreams:3000"}, nil); err == nil {
		t.Error("another machine's template changed from here")
	}
}

// Remove takes out only a setup put in from here, and none when another server here uses the database.
func TestForgetOwnAIO(t *testing.T) {
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	write := func(dir, db string) {
		_ = os.MkdirAll(dir, 0o700)
		_ = os.WriteFile(dir+"/nightcap.env", []byte("DATABASE_URL="+quoteEnv(db)+"\n"), 0o600)
	}
	home, cloud := t.TempDir()+"/home", t.TempDir()+"/cloud"
	write(home, "postgresql://u:p@db.example.com:5432/postgres?sslmode=require")
	write(cloud, "postgresql://other:q@db.example.com:6543/postgres")
	a := savedServer{Name: "Home", Slug: "home", Where: "docker", Dir: home, OwnAIO: "http://aiostreams:3000", OwnTemplate: true}
	b := savedServer{Name: "Cloud", Slug: "cloud", Where: "cloudrun", Dir: cloud, OwnAIO: "http://localhost:3000"}
	_ = saveServer(a)
	if forgetOwnAIO(savedServer{Name: "Home", Slug: "home", Where: "docker", Dir: home, OwnAIO: "http://aiostreams:3000"}) != nil {
		t.Error("no setup put in from here: one there is someone else's, and stays")
	}
	if forgetOwnAIO(a) == nil {
		t.Error("alone on its database: its setup should go")
	}
	_ = saveServer(b)
	if forgetOwnAIO(a) != nil {
		t.Error("another server uses the database: its setup should stay")
	}
	// A Kubernetes server's address, read back from secret.yaml (JSON strings: & as &).
	k := t.TempDir()
	_ = os.WriteFile(k+"/secret.yaml", []byte("stringData:\n  DATABASE_URL: \"postgresql://u:p@ep.neon.tech/db?sslmode=require\\u0026channel_binding=require\"\n"), 0o600)
	if u, err := savedDBURL(savedServer{Where: "kubernetes", Dir: k}); err != nil || u != "postgresql://u:p@ep.neon.tech/db?sslmode=require&channel_binding=require" {
		t.Errorf("secret.yaml: %q %v", u, err)
	}
}

// A made-up owner's setup, for the tests.
var sampleTemplate = []byte(`{"services":[{"id":"service-a","enabled":true}],"presets":[{"type":"addon-a"}],"x":"$tmpl$"}`)

func TestTemplateSQL(t *testing.T) {
	sql := templateSQL(sampleTemplate)
	if !strings.Contains(sql, "INSERT INTO own_aiostreams (template) VALUES ($tmplx$") || !strings.Contains(sql, `"$tmpl$"}$tmplx$::jsonb`) ||
		!strings.Contains(sql, "ON CONFLICT (one) DO UPDATE SET template = EXCLUDED.template") || strings.Contains(sql, "url") {
		t.Errorf("sql: %s", sql)
	}
	for _, bad := range []string{"", "[1,2]", "{}", "not json"} {
		if checkTemplate([]byte(bad)) == nil {
			t.Errorf("%q taken as a setup", bad)
		}
	}
}

// Its own stream finder's address is a setting, on every target.
func TestOwnAIOSetting(t *testing.T) {
	setting := func(b bundle) string {
		for _, kv := range b.serverEnv() {
			if kv[0] == "OWN_AIOSTREAMS_URL" {
				return kv[1]
			}
		}
		return ""
	}
	if got := setting(cloudSample(true)); got != "http://localhost:3000" {
		t.Errorf("cloud: %q", got)
	}
	if got := setting(cloudSample(false)); got != "" {
		t.Errorf("cloud without one: %q", got)
	}
	if got := setting(makeBundle(samplePlan("docker", "home", true), false)); got != "http://aiostreams:3000" {
		t.Errorf("docker: %q", got)
	}
	if got := setting(makeBundle(samplePlan("files", "home", true), true)); got != "http://127.0.0.1:3000" {
		t.Errorf("host network: %q", got)
	}
	k := makeBundle(samplePlan("kubernetes", "home", true), false)
	if sec := k.kubeSecret(); !strings.Contains(sec, `OWN_AIOSTREAMS_URL: "http://`+k.slug+`-aiostreams:3000"`) {
		t.Errorf("kubernetes secret:\n%s", sec)
	}
}

func TestSavedTarget(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(dir+"/nightcap.env", []byte("DATABASE_URL=postgresql://nightcap:pw@db:5432/nightcap?sslmode=disable\n"), 0o600)
	s := savedServer{Slug: "home", Where: "docker", Dir: dir, OwnAIO: "http://aiostreams:3000"}
	if tg, err := savedTarget(s); err != nil || tg.composeDir != dir {
		t.Errorf("docker: %+v %v", tg, err)
	}
	_ = os.WriteFile(dir+"/secret.yaml", []byte("stringData:\n  DATABASE_URL: \"postgresql://nightcap:pw@home-db:5432/nightcap\"\n"), 0o600)
	s = savedServer{Slug: "home", Where: "kubernetes", Dir: dir, Context: "k3s", Namespace: "nc", OwnAIO: "http://home-aiostreams:3000"}
	if tg, err := savedTarget(s); err != nil || tg.statefulset != "home-db" || tg.namespace != "nc" {
		t.Errorf("kubernetes: %+v %v", tg, err)
	}
	s.OwnAIO = ""
	if _, err := savedTarget(s); err == nil {
		t.Error("a server without its own stream finder")
	}
}

// Manage has no stream finder actions: the server's own setup is used, and an owner's is given with
// nightcap template.
func TestNoTemplateAction(t *testing.T) {
	s := savedServer{Name: "Home", Slug: "home", Where: "docker", Mode: "home", Dir: t.TempDir(), OwnAIO: "http://aiostreams:3000", Created: time.Now()}
	m := serverModel(t, s)
	m, _ = m.Update(statusMsg{dir: s.Dir, st: serverStatus{parts: []part{{"server", "running", "healthy", 0}}, answers: true, households: -1}})
	for _, o := range m.(app).server.actions.opts {
		if o.value == "template" {
			t.Errorf("a stream finder action: %+v", o)
		}
	}
}
