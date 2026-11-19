package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPluginDockerFiles(t *testing.T) {
	plugins := []savedPlugin{
		{ID: "sample", Image: "docker.io/example/plugin-a:1.0.0", Port: 8080, Service: "plugin-sample"},
		{ID: "other", Image: "docker.io/example/plugin-b:1.0.0", Port: 8080, Service: "plugin-other", HostPort: 18081},
	}
	o := override(plugins)
	for _, want := range []string{"  plugin-sample:", "env_file: plugins/sample.env", `PORT: "8080"`, `"127.0.0.1:18081:8080"`} {
		if !strings.Contains(o, want) {
			t.Errorf("override hasn't %q:\n%s", want, o)
		}
	}
	if strings.Contains(o, "name:") || strings.Count(o, "127.0.0.1") != 1 {
		t.Errorf("override:\n%s", o)
	}
	if u := pluginURLs(plugins); u != "plugin-sample:8080,127.0.0.1:18081" {
		t.Errorf("PLUGIN_URLS: %s", u)
	}
	f := pluginFile{Addon: "/{PLUGIN_TOKEN}/manifest.json"}
	if a := plugins[0].address(f); a != "http://plugin-sample:8080/{PLUGIN_TOKEN}/manifest.json" {
		t.Errorf("address: %s", a)
	}
	if a := plugins[1].address(f); a != "http://127.0.0.1:18081/{PLUGIN_TOKEN}/manifest.json" {
		t.Errorf("host-network address: %s", a)
	}
	dir := t.TempDir()
	if writeOverride(dir, plugins) != nil || writeOverride(dir, nil) != nil {
		t.Fatal("write")
	}
	if _, err := os.Stat(filepath.Join(dir, "docker-compose.override.yml")); !os.IsNotExist(err) {
		t.Error("the override stays with no plugins")
	}
	env := filepath.Join(dir, "nightcap.env")
	_ = os.WriteFile(env, []byte("MODE=home\nOWNER_KEY=AAAA\n"), 0o600)
	for i := 0; i < 2; i++ {
		if err := setEnvLine(env, "PLUGIN_URLS", "plugin-sample:8080"); err != nil {
			t.Fatal(err)
		}
	}
	data, _ := os.ReadFile(env)
	if string(data) != "MODE=home\nOWNER_KEY=AAAA\nPLUGIN_URLS=plugin-sample:8080\n" {
		t.Errorf("nightcap.env:\n%s", data)
	}
	if info, _ := os.Stat(env); info.Mode().Perm() != 0o600 {
		t.Error("permissions changed")
	}
}

func TestFreeHostPort(t *testing.T) {
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	_ = saveServer(savedServer{Name: "A", Slug: "a", Where: "docker", Dir: t.TempDir(), Plugins: []savedPlugin{{ID: "x", HostPort: 18080}}})
	if p := freeHostPort(0); p == 18080 || p == 0 {
		t.Errorf("gave a stopped server's plugin's port: %d", p)
	}
	if p := freeHostPort(18080); p != 18080 && !free(18080) {
		t.Errorf("an update kept its own port: %d", p)
	}
}

// What runs is what the screen lists, for each kind of plugin change (dry: titles only).
func TestPluginStepsRunAsListed(t *testing.T) {
	for _, c := range []struct{ where, what string }{{"docker", "add"}, {"docker", "update"}, {"docker", "remove"},
		{"kubernetes", "add"}, {"kubernetes", "update"}, {"kubernetes", "remove"},
		{"cloudrun", "add"}, {"cloudrun", "update"}, {"cloudrun", "remove"}} {
		what := c.where + " " + c.what
		o := &pluginOp{what: c.what, s: savedServer{Where: c.where}}
		var ran []string
		o.run(func(title string, _ func() (string, error)) bool { ran = append(ran, title); return true })
		if strings.Join(ran, " / ") != strings.Join(o.steps(), " / ") {
			t.Errorf("%s:\n ran    %v\n listed %v", what, ran, o.steps())
		}
	}
}

func TestKubePlugin(t *testing.T) {
	long := strings.Repeat("a", 40)
	if n := kubePluginName(long, "other-addon-plugin1"); len(n) > 63 || !strings.HasSuffix(n, "-plugin-other-addon-plugin1") {
		t.Errorf("name: %s (%d)", n, len(n))
	}
	s := savedServer{Slug: "home", Namespace: "nc"}
	p := savedPlugin{ID: "sample", Service: "home-plugin-sample", Image: "docker.io/example/plugin-a:1.0.0", Port: 8080}
	f := pluginFile{Settings: []pluginSetting{{Name: "PLUGIN_TOKEN"}, {Name: "MODEL"}, {Name: "NOTE"}}}
	y := kubePlugin(s, p, map[string]string{"PLUGIN_TOKEN": "tok", "NOTE": "it's \"quoted\" $x"}, f)
	for _, want := range []string{"kind: Secret", `NOTE: "it's \"quoted\" $x"`, `PORT: "8080"`, "app.kubernetes.io/component: plugin-sample",
		"kind: Deployment", "imagePullPolicy: Always", "envFrom: [{secretRef: {name: home-plugin-sample}}]", "kind: Service",
		"ports: [{port: 8080, targetPort: 8080}]", "namespace: nc"} {
		if !strings.Contains(y, want) {
			t.Errorf("hasn't %q:\n%s", want, y)
		}
	}
	if strings.Contains(y, "MODEL") {
		t.Error("an empty optional setting is in the Secret")
	}
	sec := filepath.Join(t.TempDir(), "secret.yaml")
	_ = os.WriteFile(sec, []byte("apiVersion: v1\nkind: Secret\nstringData:\n  MODE: \"home\"\n"), 0o600)
	for i := 0; i < 2; i++ {
		_ = setSecretLine(sec, "PLUGIN_URLS", "home-plugin-sample:8080")
	}
	if data, _ := os.ReadFile(sec); !strings.HasSuffix(string(data), "  MODE: \"home\"\n  PLUGIN_URLS: \"home-plugin-sample:8080\"\n") || strings.Count(string(data), "PLUGIN_URLS") != 1 {
		t.Errorf("secret.yaml:\n%s", data)
	}
}

func TestCloudPlugin(t *testing.T) {
	if n := cloudPluginName("home", "my-addon"); n != "home-my-addon" {
		t.Errorf("name: %s", n)
	}
	long := strings.Repeat("b", 45)
	if n := cloudPluginName(long, "other-addon"); len(n) > 49 || !strings.HasSuffix(n, "-other-addon") {
		t.Errorf("long name: %s (%d)", n, len(n))
	}
	if n := cloudPluginName("2-cabin", "my-addon"); !strings.HasPrefix(n, "nightcap-") || !strings.HasSuffix(n, "-my-addon") {
		t.Errorf("leading digit: %s", n)
	}
	s := savedServer{Slug: "home", Project: "p"}
	p := savedPlugin{ID: "sample", Service: "home-sample", Port: 8080}
	f := pluginFile{Settings: []pluginSetting{{Name: "PLUGIN_TOKEN"}, {Name: "MODEL"}}}
	svc := cloudPlugin(s, p, "docker.io/example/plugin-a@sha256:aa", map[string]string{"PLUGIN_TOKEN": "secret-token-1"}, f)
	j := string(must(json.Marshal(svc)))
	for _, want := range []string{`"autoscaling.knative.dev/maxScale":"1"`, `"autoscaling.knative.dev/minScale":"0"`, `"cpu":"1"`, `"memory":"512Mi"`,
		`"containerPort":8080`, `"run.googleapis.com/invoker-iam-disabled":"true"`, `"nightcap-server":"home"`, `"name":"PLUGIN_TOKEN","value":"secret-token-1"`} {
		if !strings.Contains(j, want) {
			t.Errorf("service hasn't %s:\n%s", want, j)
		}
	}
	if strings.Contains(j, "MODEL") || strings.Contains(j, `"name":"PORT"`) {
		t.Error("an empty setting, or PORT (Cloud Run sets it), is in the service")
	}
}

func TestComposeServices(t *testing.T) {
	dir := t.TempDir()
	b := makeBundle(samplePlan("docker", "home", true), false)
	_ = os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte(b.compose()), 0o644)
	if got := strings.Join(composeServices(dir), " "); got != "db aiostreams server" {
		t.Errorf("services: %q", got)
	}
}

// Taking a plugin out doesn't change another copy of the server's entry.
func TestKeepPluginCopies(t *testing.T) {
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	s := savedServer{Name: "A", Slug: "a", Where: "docker", Dir: t.TempDir(), Plugins: []savedPlugin{{ID: "x", Service: "plugin-x"}}}
	held := s
	o := &pluginOp{what: "remove", s: s, p: s.Plugins[0]}
	if err := o.keepPlugin(true); err != nil {
		t.Fatal(err)
	}
	if len(o.s.Plugins) != 0 || held.Plugins[0].Service != "plugin-x" {
		t.Errorf("op %v, held %v", o.s.Plugins, held.Plugins)
	}
}

// A plugin change made from an old copy of the server's entry keeps the plugins saved since.
func TestKeepPluginFresh(t *testing.T) {
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	stale := savedServer{Name: "A", Slug: "a", Where: "docker", Dir: t.TempDir()}
	saved := stale
	saved.Plugins = []savedPlugin{{ID: "first", Service: "plugin-first"}}
	_ = saveServer(saved)
	o := &pluginOp{what: "add", s: stale, p: savedPlugin{ID: "second", Service: "plugin-second"}}
	if err := o.keepPlugin(false); err != nil {
		t.Fatal(err)
	}
	list, _ := loadServers()
	if len(list) != 1 || len(list[0].Plugins) != 2 {
		t.Errorf("saved: %+v", list)
	}
}

// A plugin whose image was never got isn't run (another plugin's change doesn't bring it back).
func TestOverrideSkipsUngot(t *testing.T) {
	o := override([]savedPlugin{{ID: "bad", Service: "plugin-bad", Status: settingUp}, {ID: "ok", Service: "plugin-ok", Image: "docker.io/x/y:1", Port: 8080}})
	if strings.Contains(o, "plugin-bad") || !strings.Contains(o, "plugin-ok") {
		t.Errorf("override:\n%s", o)
	}
	if u := pluginURLs([]savedPlugin{{ID: "bad", Service: "plugin-bad"}, {ID: "ok", Service: "plugin-ok", Image: "i", Port: 8080}}); u != "plugin-ok:8080" {
		t.Errorf("PLUGIN_URLS: %s", u)
	}
}

// A Google Cloud service by a plugin's name is deleted only if this tool made it for this server.
func TestOurCloudService(t *testing.T) {
	services := map[string]string{
		"nightcap-other-addon": `{"metadata":{"name":"nightcap-other-addon","labels":{}}}`,
		"home-my-addon":        `{"metadata":{"name":"home-my-addon","labels":{"made-by":"nightcap-setup","nightcap-server":"home"}}}`,
		"other-my-addon":       `{"metadata":{"name":"other-my-addon","labels":{"made-by":"nightcap-setup","nightcap-server":"other"}}}`,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		if body, ok := services[name]; ok {
			_, _ = w.Write([]byte(body))
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"message":"not found"}}`))
	}))
	defer srv.Close()
	old := runBase
	runBase = func(string) string { return srv.URL }
	defer func() { runBase = old }()
	api := runAPI{project: "p", region: "r", token: "t"}
	ctx := context.Background()
	for name, want := range map[string]bool{"nightcap-other-addon": false, "home-my-addon": true, "other-my-addon": false, "gone": true} {
		if got := ourCloudService(ctx, api, name, "home"); got != want {
			t.Errorf("%s: %v, want %v", name, got, want)
		}
	}
}

// A plugin's file says what one copy gets on Google Cloud; unset, the defaults.
func TestCloudPluginSize(t *testing.T) {
	s := savedServer{Slug: "home", Project: "p"}
	p := savedPlugin{Service: "home-sites", Port: 8080}
	f := pluginFile{Memory: "1Gi", CPU: "1", Concurrency: 1, MaxInstances: 2, Timeout: 60}
	j := string(must(json.Marshal(cloudPlugin(s, p, "img", nil, f))))
	for _, want := range []string{`"memory":"1Gi"`, `"containerConcurrency":1`, `"autoscaling.knative.dev/maxScale":"2"`, `"timeoutSeconds":60`, `"autoscaling.knative.dev/minScale":"0"`, `"run.googleapis.com/startup-cpu-boost":"true"`} {
		if !strings.Contains(j, want) {
			t.Errorf("hasn't %s", want)
		}
	}
	j = string(must(json.Marshal(cloudPlugin(s, p, "img", nil, pluginFile{}))))
	for _, want := range []string{`"memory":"512Mi"`, `"containerConcurrency":80`, `"autoscaling.knative.dev/maxScale":"1"`, `"timeoutSeconds":300`} {
		if !strings.Contains(j, want) {
			t.Errorf("default hasn't %s", want)
		}
	}
	for _, bad := range []pluginFile{{Memory: "1G"}, {CPU: "3"}, {MaxInstances: 50}, {Timeout: 9999}} {
		bad.ID, bad.Image, bad.Port, bad.Addon = "x", "i", 80, "/m"
		if bad.check() == "" {
			t.Errorf("%+v taken", bad)
		}
	}
}
