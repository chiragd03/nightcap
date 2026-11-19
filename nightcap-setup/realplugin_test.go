package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A real Nightcap server on this computer's Docker, a real plugin added to it, checked from inside
// the server, then removed, then the server removed (NIGHTCAP_REAL_PLUGIN=1; plugin file in
// NIGHTCAP_PLUGIN_FILE).
func TestRealPluginDocker(t *testing.T) {
	if os.Getenv("NIGHTCAP_REAL_PLUGIN") == "" {
		t.Skip("NIGHTCAP_REAL_PLUGIN=1")
	}
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	p := samplePlan("docker", "home", true)
	p.keys.ownAIO = false // (lighter: no stream finder for this)
	p.settings.name = "Plugin Test"
	p.db.docker.port = 55488
	d := newDeployer(p)
	go d.run(0)
	for m := range d.out {
		if m.err != nil {
			t.Fatalf("setting up: %v", m.err)
		}
		if m.end {
			break
		}
	}
	list, _ := loadServers()
	if len(list) != 1 {
		t.Fatalf("saved: %+v", list)
	}
	s := list[0]
	defer func() {
		if _, err := removeServerNoting(s); err != nil {
			t.Errorf("removing the server: %v", err)
		}
	}()
	t.Logf("server up: %s", s.Dir)
	f := readPluginFile(os.Getenv("NIGHTCAP_PLUGIN_FILE"))
	if f.Err != "" {
		t.Fatal(f.Err)
	}
	values := map[string]string{}
	for _, st := range f.Settings {
		if st.Made {
			values[st.Name] = randomToken()
		} else if !st.Optional {
			values[st.Name] = "not-a-real-key"
		}
	}
	steps := func(o *pluginOp) {
		t.Helper()
		ok := o.run(func(title string, fn func() (string, error)) bool {
			start := time.Now()
			note, err := fn()
			t.Logf("  %s: %v %s (%s)", title, err, note, time.Since(start).Round(time.Second))
			return err == nil
		})
		if !ok {
			t.Fatalf("%s failed", o.what)
		}
	}
	// One whose image can't be had: its add fails, it's removable, and the server still starts.
	bad := f
	bad.ID, bad.Name, bad.Image = "broken", "Broken", "docker.io/chiragdahiya3/no-such-image-here:0.0.0"
	badOp := &pluginOp{what: "add", s: s, f: bad, values: values}
	if badOp.run(func(title string, fn func() (string, error)) bool { _, err := fn(); return err == nil }) {
		t.Fatal("a plugin with no image was added")
	}
	s = freshServer(s)
	steps(&pluginOp{what: "remove", s: s, p: s.Plugins[0]})
	s = freshServer(s)
	if _, err := composeLong(s.Dir, "up", "-d"); err != nil {
		t.Fatalf("the server doesn't start after a failed plugin: %v", err)
	}
	add := &pluginOp{what: "add", s: s, f: f, values: values}
	steps(add)
	list, _ = loadServers()
	s = list[0]
	if len(s.Plugins) != 1 || s.Plugins[0].Status != "" {
		t.Fatalf("saved plugin: %+v", s.Plugins)
	}
	env, _ := os.ReadFile(filepath.Join(s.Dir, "nightcap.env"))
	if !strings.Contains(string(env), "PLUGIN_URLS=plugin-"+f.ID+":8080") {
		t.Errorf("PLUGIN_URLS not set:\n%s", env)
	}
	st := statusOf(s, false)
	for _, pt := range st.parts {
		if strings.HasPrefix(pt.name, "plugin-") {
			t.Errorf("a plugin in the server's parts: %+v", st.parts)
		}
	}
	if st.plugins[f.ID] != "running" {
		t.Errorf("plugin state: %v", st.plugins)
	}
	// Updated: made again, checked again.
	steps(&pluginOp{what: "update", s: s, f: f, p: s.Plugins[0], values: values})
	// Removed.
	steps(&pluginOp{what: "remove", s: s, p: s.Plugins[0]})
	list, _ = loadServers()
	s = list[0]
	if len(s.Plugins) != 0 {
		t.Errorf("still saved: %+v", s.Plugins)
	}
	if _, err := os.Stat(filepath.Join(s.Dir, "docker-compose.override.yml")); !os.IsNotExist(err) {
		t.Error("the override file stays")
	}
	if out, _ := composeOut(s.Dir, "ps", "-a", "--format", "{{.Service}}"); strings.Contains(out, "plugin-") {
		t.Errorf("its container stays: %s", out)
	}
}

// The same on a real cluster: a server set up in a new namespace (NIGHTCAP_REAL_KUBE_NS, made and
// removed with it), a plugin added, checked from inside the server's pod, updated, removed.
func TestRealPluginKube(t *testing.T) {
	ns := os.Getenv("NIGHTCAP_REAL_KUBE_NS")
	if ns == "" || os.Getenv("NIGHTCAP_PLUGIN_FILE") == "" {
		t.Skip("NIGHTCAP_REAL_KUBE_NS, NIGHTCAP_PLUGIN_FILE")
	}
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	p := samplePlan("kubernetes", "home", true)
	p.keys.ownAIO = false
	p.settings.name = "Plugin Kube Test"
	p.kube = kubePlan{context: os.Getenv("NIGHTCAP_REAL_KUBE_CONTEXT"), namespace: ns, newNamespace: true, nodeIP: os.Getenv("NIGHTCAP_REAL_KUBE_NODE")}
	d := newDeployer(p)
	go d.run(0)
	for m := range d.out {
		if m.err != nil {
			t.Fatalf("setting up: %v", m.err)
		}
		if m.end {
			break
		}
	}
	list, _ := loadServers()
	s := list[0]
	defer func() {
		if _, err := removeServerNoting(s); err != nil {
			t.Errorf("removing the server: %v", err)
		}
	}()
	f := readPluginFile(os.Getenv("NIGHTCAP_PLUGIN_FILE"))
	values := map[string]string{}
	for _, st := range f.Settings {
		if st.Made {
			values[st.Name] = randomToken()
		} else if !st.Optional {
			values[st.Name] = "not-a-real-key"
		}
	}
	steps := func(o *pluginOp) {
		t.Helper()
		ok := o.run(func(title string, fn func() (string, error)) bool {
			start := time.Now()
			note, err := fn()
			t.Logf("  %s: %v %s (%s)", title, err, note, time.Since(start).Round(time.Second))
			return err == nil
		})
		if !ok {
			t.Fatalf("%s failed", o.what)
		}
	}
	steps(&pluginOp{what: "add", s: s, f: f, values: values})
	list, _ = loadServers()
	s = list[0]
	sec, _ := os.ReadFile(filepath.Join(s.Dir, "secret.yaml"))
	if !strings.Contains(string(sec), `PLUGIN_URLS: "`+s.Plugins[0].Service+`:8080"`) {
		t.Errorf("PLUGIN_URLS not in secret.yaml")
	}
	st := statusOf(s, false)
	if st.plugins[f.ID] != "running" {
		t.Errorf("plugin state: %v (parts %v)", st.plugins, st.parts)
	}
	steps(&pluginOp{what: "update", s: s, f: f, p: s.Plugins[0], values: values})
	steps(&pluginOp{what: "remove", s: s, p: s.Plugins[0]})
}

// On Google Cloud: a plugin added as its own service in a project (NIGHTCAP_REAL_CLOUD_PROJECT, with
// Cloud Run on), checked at its public address, updated, removed. No server is needed for it.
func TestRealPluginCloud(t *testing.T) {
	project := os.Getenv("NIGHTCAP_REAL_CLOUD_PROJECT")
	if project == "" || os.Getenv("NIGHTCAP_PLUGIN_FILE") == "" {
		t.Skip("NIGHTCAP_REAL_CLOUD_PROJECT, NIGHTCAP_PLUGIN_FILE")
	}
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	s := savedServer{Name: "Plugin Cloud Test", Slug: "plugintest", Where: "cloudrun", Mode: "cloud", Dir: filepath.Join(serversDir(), "plugintest"),
		Account: os.Getenv("NIGHTCAP_REAL_CLOUD_ACCOUNT"), Project: project, Region: "northamerica-northeast1", Created: time.Now()}
	_ = os.MkdirAll(s.Dir, 0o700)
	_ = saveServer(s)
	f := readPluginFile(os.Getenv("NIGHTCAP_PLUGIN_FILE"))
	values := map[string]string{}
	for _, st := range f.Settings {
		if st.Made {
			values[st.Name] = randomToken()
		} else if !st.Optional {
			values[st.Name] = "not-a-real-key"
		}
	}
	steps := func(o *pluginOp) bool {
		t.Helper()
		return o.run(func(title string, fn func() (string, error)) bool {
			start := time.Now()
			note, err := fn()
			if len(note) > 60 {
				note = note[:60] + "…"
			}
			t.Logf("  %s: %v %s (%s)", title, err, note, time.Since(start).Round(time.Second))
			return err == nil
		})
	}
	ok := steps(&pluginOp{what: "add", s: s, f: f, values: values})
	s = freshServer(s)
	if len(s.Plugins) == 1 {
		p := s.Plugins[0]
		t.Logf("service %s, address %s", p.Service, strings.Replace(p.Address, "{PLUGIN_TOKEN}", "<token>", 1))
		if ok {
			ok = steps(&pluginOp{what: "update", s: s, f: f, p: p, values: values})
			s = freshServer(s)
		}
		if !steps(&pluginOp{what: "remove", s: s, p: s.Plugins[0]}) {
			t.Error("remove failed: delete the service by hand")
		}
	}
	if !ok {
		t.Error("add or update failed")
	}
}
