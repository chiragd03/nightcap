package main

import (
	"bytes"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

// Plugins run next to a server (one more container, pod or Cloud Run service). The tool knows none
// of them: each is described by a file in ~/.nightcap-setup/plugins/ (its image, port, settings, and
// the path of its add-on address). With no files there, there's no plugin option anywhere.

// pluginSetting is one of a plugin's settings (an environment variable).
type pluginSetting struct {
	Name     string `yaml:"name"`
	Ask      string `yaml:"ask"`      // the question on its screen
	Secret   bool   `yaml:"secret"`   // hidden while typed, never shown or logged
	Made     bool   `yaml:"made"`     // made by the tool (a random value), never asked
	Optional bool   `yaml:"optional"` // may be left empty (then not set)
}

// pluginFile is a plugin as its file describes it.
type pluginFile struct {
	Name     string          `yaml:"name"`
	Image    string          `yaml:"image"`
	Port     int             `yaml:"port"`
	Addon    string          `yaml:"addon"` // its add-on's path, e.g. /{PLUGIN_TOKEN}/manifest.json
	Settings []pluginSetting `yaml:"settings"`
	// On Google Cloud only: what one copy of it gets, and how far it may grow (unset: the defaults).
	Memory       string `yaml:"memory"`        // 256Mi, 1Gi…
	CPU          string `yaml:"cpu"`           // 1, 2…
	Concurrency  int    `yaml:"concurrency"`   // requests one copy takes at once
	MaxInstances int    `yaml:"max_instances"` // copies at most (capped at 10: it caps the bill too)
	Timeout      int    `yaml:"timeout"`       // seconds a request may take
	ID           string `yaml:"-"`             // from the file's name
	Err          string `yaml:"-"`             // why it can't be used ("" if it can)
}

// savedPlugin is a plugin running next to a saved server.
type savedPlugin struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Image    string    `json:"image"`              // as run (its digest on Google Cloud)
	Port     int       `json:"port"`               // the one it listens on
	HostPort int       `json:"hostPort,omitempty"` // on this computer's own network: where it's reached
	Service  string    `json:"service"`            // its Compose service, Kubernetes name or Cloud Run service
	Address  string    `json:"address"`            // its add-on address, with {SETTING} for its values
	Status   string    `json:"status,omitempty"`   // settingUp until it's added
	Added    time.Time `json:"added"`
}

func pluginsDir() string { return filepath.Join(setupHome(), "plugins") }

var (
	settingName = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)
	placeholder = regexp.MustCompile(`\{([A-Z][A-Z0-9_]*)\}`)
	memorySize  = regexp.MustCompile(`^[1-9][0-9]*(Mi|Gi)$`)
	cpuCount    = regexp.MustCompile(`^(1|2|4|8)$`)
)

// loadPluginFiles reads every plugin file, in name order; a broken one comes back with its Err.
func loadPluginFiles() []pluginFile {
	entries, _ := os.ReadDir(pluginsDir())
	var out []pluginFile
	for _, e := range entries {
		ext := filepath.Ext(e.Name())
		if e.IsDir() || (ext != ".yaml" && ext != ".yml") {
			continue
		}
		out = append(out, readPluginFile(filepath.Join(pluginsDir(), e.Name())))
	}
	sort.SliceStable(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}

func readPluginFile(path string) pluginFile {
	base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	p := pluginFile{ID: pluginID(base), Name: base}
	data, err := os.ReadFile(path)
	if err != nil {
		p.Err = "can't be read"
		return p
	}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	var f pluginFile
	if err := dec.Decode(&f); err != nil {
		p.Err = "isn't a plugin file: " + firstLine(err.Error())
		return p
	}
	f.ID = p.ID
	if f.Name == "" {
		f.Name = base
	}
	f.Err = f.check()
	return f
}

// check is what's wrong with a plugin file ("" if nothing).
func (f pluginFile) check() string {
	switch {
	case f.ID == "":
		return "its file name has no letters or digits"
	case f.Image == "":
		return "it has no image"
	case f.Port < 1 || f.Port > 65535:
		return "its port isn't a port number"
	case !strings.HasPrefix(f.Addon, "/"):
		return "its add-on path doesn't start with /"
	case f.Memory != "" && !memorySize.MatchString(f.Memory):
		return "its memory isn't a size like 256Mi or 1Gi"
	case f.CPU != "" && !cpuCount.MatchString(f.CPU):
		return "its cpu isn't 1, 2, 4 or 8"
	case f.Concurrency < 0 || f.Concurrency > 1000:
		return "its concurrency isn't 1 to 1000"
	case f.MaxInstances < 0 || f.MaxInstances > 10:
		return "its max_instances isn't 1 to 10"
	case f.Timeout < 0 || f.Timeout > 3600:
		return "its timeout isn't 1 to 3600 seconds"
	}
	seen := map[string]bool{}
	for _, s := range f.Settings {
		switch {
		case !settingName.MatchString(s.Name):
			return fmt.Sprintf("setting %q isn't a name like API_KEY", s.Name)
		case seen[s.Name]:
			return "setting " + s.Name + " is there twice"
		case s.Name == "PORT":
			return "PORT is set by the tool, not the file"
		case !s.Made && s.Ask == "":
			return "setting " + s.Name + " has no question (ask:) and isn't made by the tool"
		}
		seen[s.Name] = true
	}
	for _, m := range placeholder.FindAllStringSubmatch(f.Addon, -1) {
		if !seen[m[1]] {
			return "its add-on path names " + m[1] + ", which isn't one of its settings"
		}
	}
	return ""
}

// pluginID is a name safe for a container, a Kubernetes object and a Cloud Run service: letters,
// digits and dashes, at most 20.
func pluginID(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		case b.Len() > 0 && !dash:
			b.WriteByte('-')
			dash = true
		}
	}
	id := strings.Trim(b.String(), "-")
	if len(id) > 20 {
		id = strings.TrimRight(id[:20], "-")
	}
	return id
}

// randomToken is a random value for a setting the tool makes: 32 letters and digits.
func randomToken() string {
	const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, 32)
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		b[i] = chars[n.Int64()]
	}
	return string(b)
}

// fill puts a plugin's values into a template ("/{PLUGIN_TOKEN}/manifest.json").
func fill(template string, values map[string]string) string {
	return placeholder.ReplaceAllStringFunc(template, func(m string) string { return values[m[1:len(m)-1]] })
}

// A plugin's values are kept in plugins/<id>.env in its server's folder (only its owner can read it),
// each secret one with a "# secret" line above it, so logs are cleaned of it.
func pluginEnvPath(serverDir, id string) string {
	return filepath.Join(serverDir, "plugins", id+".env")
}

func writePluginEnv(serverDir, id string, f pluginFile, values map[string]string) error {
	if err := os.MkdirAll(filepath.Join(serverDir, "plugins"), 0o700); err != nil {
		return err
	}
	var s strings.Builder
	s.WriteString("# The " + f.Name + " plugin's settings. Made by nightcap-setup: keep it private.\n")
	for _, st := range f.Settings {
		v, ok := values[st.Name]
		if !ok || v == "" {
			continue // (an optional one left empty: not set)
		}
		if st.Secret {
			s.WriteString("# secret\n")
		}
		s.WriteString(st.Name + "=" + quoteEnv(v) + "\n")
	}
	path := pluginEnvPath(serverDir, id)
	if err := os.WriteFile(path, []byte(s.String()), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// readPluginEnv is a plugin's values, and which of them are secret.
func readPluginEnv(serverDir, id string) (map[string]string, []string, error) {
	data, err := os.ReadFile(pluginEnvPath(serverDir, id))
	if err != nil {
		return nil, nil, errors.New("its settings aren't there any more")
	}
	values := map[string]string{}
	var secrets []string
	secret := false
	for _, l := range strings.Split(string(data), "\n") {
		l = strings.TrimSpace(l)
		if l == "# secret" {
			secret = true
			continue
		}
		k, v, ok := strings.Cut(l, "=")
		if !ok || strings.HasPrefix(l, "#") {
			continue
		}
		values[k] = unquoteEnv(v)
		if secret {
			secrets = append(secrets, values[k])
		}
		secret = false
	}
	return values, secrets, nil
}

// pluginSecrets is every secret value of a server's plugins (for cleaning logs).
func pluginSecrets(serverDir string) []string {
	var out []string
	files, _ := filepath.Glob(filepath.Join(serverDir, "plugins", "*.env"))
	for _, f := range files {
		if _, s, err := readPluginEnv(serverDir, strings.TrimSuffix(filepath.Base(f), ".env")); err == nil {
			out = append(out, s...)
		}
	}
	return out
}
