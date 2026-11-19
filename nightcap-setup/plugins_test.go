package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const samplePluginFile = `name: Sample
image: docker.io/example/plugin-a:1.0.0
port: 8080
addon: /{PLUGIN_TOKEN}/manifest.json
settings:
  - name: PLUGIN_TOKEN
    secret: true
    made: true
  - name: SERVICE_KEY
    secret: true
    ask: Your service-a key
  - name: MODEL
    optional: true
    ask: Model (optional)
`

func TestPluginFiles(t *testing.T) {
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	if got := loadPluginFiles(); len(got) != 0 {
		t.Fatalf("no folder: %v", got)
	}
	_ = os.MkdirAll(pluginsDir(), 0o700)
	write := func(name, body string) { _ = os.WriteFile(filepath.Join(pluginsDir(), name), []byte(body), 0o600) }
	write("Sample Plugin.yaml", samplePluginFile)
	write("broken.yml", "name: Broken\nimage: x\nport: 99999\naddon: /m\n")
	write("unknown.yaml", "name: U\nimage: x\nport: 80\naddon: /m\nextra: 1\n")
	write("noask.yaml", "name: N\nimage: x\nport: 80\naddon: /{TOKEN}/m\nsettings:\n  - name: KEY\n")
	write("notes.txt", "not a plugin")
	got := loadPluginFiles()
	if len(got) != 4 {
		t.Fatalf("files: %+v", got)
	}
	byName := map[string]pluginFile{}
	for _, f := range got {
		byName[f.Name] = f
	}
	if s := byName["Sample"]; s.Err != "" || s.ID != "sample-plugin" || s.Port != 8080 || len(s.Settings) != 3 || !s.Settings[0].Made {
		t.Errorf("sample: %+v", s)
	}
	if !strings.Contains(byName["Broken"].Err, "port") {
		t.Errorf("broken: %q", byName["Broken"].Err)
	}
	if !strings.Contains(byName["unknown"].Err, "isn't a plugin file") && !strings.Contains(byName["U"].Err, "isn't a plugin file") {
		t.Errorf("unknown field taken: %+v", got)
	}
	if !strings.Contains(byName["N"].Err, "no question") {
		t.Errorf("no ask: %q", byName["N"].Err)
	}
}

func TestPluginEnv(t *testing.T) {
	dir := t.TempDir()
	var f pluginFile
	_ = os.MkdirAll(dir, 0o700)
	f = readPluginFileFrom(t, samplePluginFile)
	token := randomToken()
	values := map[string]string{"PLUGIN_TOKEN": token, "SERVICE_KEY": "it's a $secret", "MODEL": ""}
	if err := writePluginEnv(dir, "sample", f, values); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(pluginEnvPath(dir, "sample")); info.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", info.Mode().Perm())
	}
	got, secrets, err := readPluginEnv(dir, "sample")
	if err != nil || got["SERVICE_KEY"] != "it's a $secret" || got["PLUGIN_TOKEN"] != token || len(secrets) != 2 {
		t.Errorf("read back: %v %v %v", got, secrets, err)
	}
	if _, ok := got["MODEL"]; ok {
		t.Error("an empty optional setting was written")
	}
	if fill(f.Addon, got) != "/"+token+"/manifest.json" {
		t.Errorf("address: %s", fill(f.Addon, got))
	}
	all := strings.Join(serverSecrets(dir), " ")
	if !strings.Contains(all, token) || !strings.Contains(all, "it's a $secret") {
		t.Error("plugin secrets aren't cleaned from logs")
	}
	if len(token) != 32 || randomToken() == token {
		t.Error("token")
	}
	if pluginID("  My Add-on!! (v2) and a very long name ") != "my-add-on-v2-and-a-v" {
		t.Errorf("id: %s", pluginID("  My Add-on!! (v2) and a very long name "))
	}
}

func readPluginFileFrom(t *testing.T, body string) pluginFile {
	t.Helper()
	p := filepath.Join(t.TempDir(), "sample.yaml")
	_ = os.WriteFile(p, []byte(body), 0o600)
	f := readPluginFile(p)
	if f.Err != "" {
		t.Fatal(f.Err)
	}
	return f
}
