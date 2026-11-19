package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// pluginOp adds, updates or removes one plugin of a saved server, a step at a time (the screen shows
// its steps as they go).
type pluginOp struct {
	what   string // "add", "update" or "remove"
	s      savedServer
	f      pluginFile        // its file (add, update)
	p      savedPlugin       // the plugin (update, remove; made by add)
	values map[string]string // its settings (add, update)
}

type stepFn func(title string, fn func() (string, error)) bool

func (o *pluginOp) steps() []string {
	switch o.what {
	case "remove":
		return []string{"Stopping it", "Telling the server"}
	case "update":
		if o.s.Where == "cloudrun" {
			return []string{"Getting the newest image", "Starting it", "Checking it answers"}
		}
		return []string{"Getting the newest image", "Starting it", "Letting the server reach it", "Checking it answers"}
	}
	if o.s.Where == "cloudrun" { // (a public address: nothing to change on the server)
		return []string{"Getting the image", "Starting it", "Checking it answers"}
	}
	return []string{"Getting the image", "Starting it", "Letting the server reach it", "Checking it answers"}
}

// run does the steps, stopping at the first that fails.
func (o *pluginOp) run(step stepFn) bool {
	switch o.s.Where {
	case "docker":
		return o.runDocker(step)
	case "kubernetes":
		return o.runKube(step)
	case "cloudrun":
		return o.runCloud(step)
	}
	return step(o.steps()[0], func() (string, error) { return "", errNotYet })
}

// --- On Docker: plugins are services of the server's own Compose project, in
// docker-compose.override.yml (Compose reads it with the main file, so starting, stopping, looking at
// and removing the server include them).

func pluginService(id string) string { return "plugin-" + id }

func composeHostNet(dir string) bool {
	data, _ := os.ReadFile(filepath.Join(dir, "docker-compose.yml"))
	return strings.Contains(string(data), "network_mode: host")
}

// override is the override file for [plugins] ("" when there are none).
func override(all []savedPlugin) string {
	var plugins []savedPlugin
	for _, p := range all {
		if p.Image != "" { // (one whose image was never got isn't run)
			plugins = append(plugins, p)
		}
	}
	if len(plugins) == 0 {
		return ""
	}
	var s strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&s, format+"\n", a...) }
	w("# This server's plugins. Made by nightcap-setup: changed from its Manage screen.")
	w("services:")
	for _, p := range plugins {
		w("  %s:", p.Service)
		w("    image: %s", p.Image)
		w("    restart: unless-stopped")
		w("    env_file: plugins/%s.env", p.ID)
		w("    environment:")
		w("      PORT: \"%d\"", p.Port)
		if p.HostPort != 0 { // (on this computer's own network: the server reaches it here)
			w("    ports:")
			w("      - \"127.0.0.1:%d:%d\"", p.HostPort, p.Port)
		}
	}
	return s.String()
}

func writeOverride(dir string, plugins []savedPlugin) error {
	path := filepath.Join(dir, "docker-compose.override.yml")
	body := override(plugins)
	if body == "" {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return os.WriteFile(path, []byte(body), 0o644)
}

// pluginURLs is the PLUGIN_URLS setting for a server's plugins: the exact host:port it reaches each at.
func pluginURLs(plugins []savedPlugin) string {
	var out []string
	for _, p := range plugins {
		if p.Image == "" {
			continue // (not run: see override)
		}
		if p.HostPort != 0 {
			out = append(out, fmt.Sprintf("127.0.0.1:%d", p.HostPort))
		} else {
			out = append(out, fmt.Sprintf("%s:%d", p.Service, p.Port))
		}
	}
	return strings.Join(out, ",")
}

// setEnvLine sets KEY=value in an env file, keeping its other lines and its permissions.
func setEnvLine(path, key, value string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	line, found := key+"="+quoteEnv(value), false
	for i, l := range lines {
		if strings.HasPrefix(l, key+"=") {
			lines[i], found = line, true
		}
	}
	if !found {
		lines = append(lines, line)
	}
	return os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), info.Mode().Perm())
}

// freeHostPort is a port for a plugin on this computer's own network: free now, and not one another
// saved server's plugin (perhaps stopped) has.
func freeHostPort(skip int) int {
	taken := map[int]bool{serverPortN: true}
	list, _ := loadServers()
	for _, s := range list {
		for _, p := range s.Plugins {
			if p.HostPort != skip {
				taken[p.HostPort] = true
			}
		}
	}
	for port := 18080; port < 18200; port++ {
		if !taken[port] && (port == skip || free(port)) {
			return port
		}
	}
	return 0
}

// serverRunning is whether a Docker server's own container is running.
func serverRunning(dir string) bool {
	out, err := composeOut(dir, "ps", "--status", "running", "-q", "server")
	return err == nil && strings.TrimSpace(out) != ""
}

// keepPlugin saves the plugin in its server's entry (replacing one with its ID), or takes it out.
func (o *pluginOp) keepPlugin(gone bool) error {
	o.s = freshServer(o.s)                  // (as saved now: an older copy of it doesn't lose another plugin)
	o.s.Plugins = slices.Clone(o.s.Plugins) // (a copy: other copies of the server's entry keep theirs)
	i := slices.IndexFunc(o.s.Plugins, func(p savedPlugin) bool { return p.ID == o.p.ID })
	switch {
	case gone && i >= 0:
		o.s.Plugins = slices.Delete(o.s.Plugins, i, i+1)
	case !gone && i >= 0:
		o.s.Plugins[i] = o.p
	case !gone:
		o.s.Plugins = append(o.s.Plugins, o.p)
	}
	return saveServer(o.s)
}

func (o *pluginOp) runDocker(step stepFn) bool {
	dir := o.s.Dir
	tellServer := func() (string, error) {
		if err := writeOverride(dir, o.s.Plugins); err != nil {
			return "", err
		}
		if err := setEnvLine(filepath.Join(dir, "nightcap.env"), "PLUGIN_URLS", pluginURLs(o.s.Plugins)); err != nil {
			return "", err
		}
		if !serverRunning(dir) {
			return "it uses it when started", nil
		}
		// (A new container: the setting is read as it starts.)
		_, err := composeLong(dir, "up", "-d", "--no-deps", "--force-recreate", "server")
		return "", err
	}
	if o.what == "remove" {
		return step("Stopping it", func() (string, error) {
			if o.p.Image == "" {
				return "", nil // (its image was never got: it never ran)
			}
			if _, err := composeLong(dir, "rm", "-sf", o.p.Service); err != nil && !strings.Contains(strings.ToLower(err.Error()), "no such service") {
				return "", err
			}
			return "", nil
		}) && step("Telling the server", func() (string, error) {
			if err := o.keepPlugin(true); err != nil {
				return "", err
			}
			_ = os.Remove(pluginEnvPath(dir, o.p.ID))
			return tellServer()
		})
	}
	first := "Getting the image"
	if o.what == "update" {
		first = "Getting the newest image"
	}
	ok := step(first, func() (string, error) {
		if o.what == "add" {
			o.p = savedPlugin{ID: o.f.ID, Name: o.f.Name, Service: pluginService(o.f.ID), Status: settingUp, Added: time.Now()}
			if composeHostNet(dir) {
				if o.p.HostPort = freeHostPort(0); o.p.HostPort == 0 {
					return "", errors.New("no free port for it on this computer (18080 to 18199)")
				}
			}
		}
		if err := writePluginEnv(dir, o.p.ID, o.f, o.values); err != nil {
			return "", err
		}
		if err := o.keepPlugin(false); err != nil { // (saved before anything runs: Remove finds it)
			return "", err
		}
		// The image is got first, and only then saved as its own (with its port and address): one
		// that can't be had never goes in the override, now or with a later plugin's change, where
		// it would stop the server from starting.
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if out, err := exec.CommandContext(ctx, "docker", "pull", "--quiet", o.f.Image).CombinedOutput(); err != nil {
			return "", fmt.Errorf("couldn't get %s: %s", o.f.Image, scrub(firstLine(strings.TrimSpace(string(out)))))
		}
		o.p.Image, o.p.Name, o.p.Port = o.f.Image, o.f.Name, o.f.Port
		o.p.Address = o.p.address(o.f)
		if err := o.keepPlugin(false); err != nil {
			return "", err
		}
		return o.p.Image, writeOverride(dir, o.s.Plugins)
	}) && step("Starting it", func() (string, error) {
		_, err := composeLong(dir, "up", "-d", "--no-deps", "--force-recreate", o.p.Service)
		return "", err
	})
	// (An update too: a half-added one, or a new port, needs it.)
	ok = ok && step("Letting the server reach it", tellServer)
	return ok && step("Checking it answers", func() (string, error) {
		if err := checkPlugin(exec.Command("docker", "compose", "exec", "-T", "server", "python", "-"), dir, fill(o.p.Address, o.values)); err != nil {
			return "", err
		}
		o.p.Status = "" // (added: done)
		return "", o.keepPlugin(false)
	})
}

// address is the plugin's add-on address as the server reaches it, with {SETTING} for its values.
func (p savedPlugin) address(f pluginFile) string {
	host := fmt.Sprintf("http://%s:%d", p.Service, p.Port)
	if p.HostPort != 0 {
		host = fmt.Sprintf("http://127.0.0.1:%d", p.HostPort)
	}
	return host + f.Addon
}

// checkPlugin asks the plugin for its add-on from inside the server (the server's own way of
// fetching, so the address it's allowed to reach is what's tested), for up to 20 seconds. Nothing of
// the address is said in what comes back: it holds the plugin's token.
func checkPlugin(cmd *exec.Cmd, dir, address string) error {
	script := fmt.Sprintf(`import sys, time
sys.path.insert(0, "/app")
from nightcap.http import get_json
end = time.time() + 20
while True:
    try:
        m = get_json(%q, retries=0, timeout=5)
        print("ok" if isinstance(m, dict) and m.get("id") else "not an add-on")
        break
    except Exception as e:
        if time.time() > end:
            print("no answer (" + type(e).__name__ + ")")
            break
        time.sleep(2)
`, address)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, cmd.Path, cmd.Args[1:]...)
	c.Dir = dir
	c.Stdin = strings.NewReader(script)
	var out bytes.Buffer
	c.Stdout, c.Stderr = &out, &out
	err := c.Run()
	got := strings.TrimSpace(out.String())
	if lines := strings.Split(got, "\n"); len(lines) > 0 {
		got = lines[len(lines)-1]
	}
	switch {
	case err != nil && got == "":
		return fmt.Errorf("couldn't ask from inside the server: %v", err)
	case got == "ok":
		return nil
	case got == "not an add-on":
		return errors.New("it answers, but not with an add-on: check its file's add-on path")
	}
	return errors.New("the server can't reach it: " + scrub(got))
}

// freshServer is a server's entry as saved now (the one given, if it isn't saved).
func freshServer(s savedServer) savedServer {
	list, _ := loadServers()
	for _, sv := range list {
		if sv.Dir == s.Dir {
			return sv
		}
	}
	return s
}
