package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// On Kubernetes: a plugin is a Deployment, a Service and a Secret (its settings) in its server's
// namespace, named <slug>-plugin-<id> and labelled as the server's parts are (so stopping and
// starting the server include it), with a component of its own.

// kubePluginName fits a Kubernetes name (63 characters).
func kubePluginName(slug, id string) string {
	tail := "-plugin-" + id
	if len(slug)+len(tail) > 63 {
		slug = strings.TrimRight(slug[:63-len(tail)], "-")
	}
	return slug + tail
}

// kubePlugin is the plugin's objects, its settings in the Secret as they are (not as the env file
// quotes them).
func kubePlugin(s savedServer, p savedPlugin, values map[string]string, f pluginFile) string {
	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format+"\n", a...) }
	labels := func(indent string) {
		w("%slabels:", indent)
		w("%s  app.kubernetes.io/instance: %s", indent, s.Slug)
		w("%s  app.kubernetes.io/part-of: nightcap", indent)
		w("%s  app.kubernetes.io/component: plugin-%s", indent, p.ID)
	}
	w("apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n  namespace: %s", p.Service, s.Namespace)
	labels("  ")
	w("type: Opaque\nstringData:")
	for _, st := range f.Settings {
		if v := values[st.Name]; v != "" {
			w("  %s: %s", st.Name, q(v))
		}
	}
	w("  PORT: %s", q(fmt.Sprint(p.Port)))
	w("---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: %s\n  namespace: %s", p.Service, s.Namespace)
	labels("  ")
	w("spec:\n  replicas: 1\n  selector:\n    matchLabels:")
	w("      app.kubernetes.io/instance: %s\n      app.kubernetes.io/component: plugin-%s", s.Slug, p.ID)
	w("  template:\n    metadata:")
	labels("      ")
	w("    spec:\n      containers:\n        - name: plugin\n          image: %s\n          imagePullPolicy: Always", p.Image)
	w("          ports: [{containerPort: %d}]", p.Port)
	w("          envFrom: [{secretRef: {name: %s}}]", p.Service)
	w("---\napiVersion: v1\nkind: Service\nmetadata:\n  name: %s\n  namespace: %s", p.Service, s.Namespace)
	labels("  ")
	w("spec:\n  selector: {app.kubernetes.io/instance: %s, app.kubernetes.io/component: plugin-%s}", s.Slug, p.ID)
	w("  ports: [{port: %d, targetPort: %d}]", p.Port, p.Port)
	return b.String()
}

// setSecretLine sets KEY: "value" in a secret.yaml's stringData, keeping its other lines.
func setSecretLine(path, key, value string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	line, found := "  "+key+": "+q(value), false
	for i, l := range lines {
		if strings.HasPrefix(l, "  "+key+":") {
			lines[i], found = line, true
		}
	}
	if !found {
		lines = append(lines, line) // (stringData is the file's last part)
	}
	return os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), info.Mode().Perm())
}

func (o *pluginOp) runKube(step stepFn) bool {
	s := o.s
	ctx := context.Background()
	kc := func(args ...string) (string, error) {
		return kubectl(ctx, s.Context, append([]string{"-n", s.Namespace}, args...)...)
	}
	apply := func(yaml string) error {
		args := []string{"-n", s.Namespace, "apply", "-f", "-"}
		if s.Context != "" {
			args = append([]string{"--context", s.Context}, args...)
		}
		cmd := exec.CommandContext(ctx, "kubectl", args...)
		cmd.Stdin = strings.NewReader(yaml)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("kubectl apply: %s", scrub(firstLine(strings.TrimSpace(string(out)))))
		}
		return nil
	}
	server := "deployment/" + s.Slug + "-server"
	tellServer := func() (string, error) {
		if err := setSecretLine(filepath.Join(s.Dir, "secret.yaml"), "PLUGIN_URLS", pluginURLs(o.s.Plugins)); err != nil {
			return "", err
		}
		if _, err := kc("apply", "-f", filepath.Join(s.Dir, "secret.yaml")); err != nil {
			return "", err
		}
		// (It reads the setting as it starts: only the server's own pods are made again.)
		if _, err := kc("rollout", "restart", server); err != nil {
			return "", err
		}
		_, err := kc("rollout", "status", server, "--timeout", "5m")
		return "", err
	}
	if o.what == "remove" {
		return step("Stopping it", func() (string, error) {
			if !ourKubePlugin(s, o.p.Service) {
				return "not this server's: left as it is", nil
			}
			_, err := kc("delete", "deployment,service,secret", o.p.Service, "--ignore-not-found")
			return "", err
		}) && step("Telling the server", func() (string, error) {
			if err := o.keepPlugin(true); err != nil {
				return "", err
			}
			_ = os.Remove(pluginEnvPath(s.Dir, o.p.ID))
			return tellServer()
		})
	}
	first := "Getting the image"
	if o.what == "update" {
		first = "Getting the newest image"
	}
	ok := step(first, func() (string, error) {
		if o.what == "add" {
			name := kubePluginName(s.Slug, o.f.ID)
			// (Names of someone else's aren't written over: all three checked.)
			if !ourKubePlugin(s, name) {
				return "", fmt.Errorf("%s in %s isn't this server's: not touched (rename the plugin's file: its name names it)", name, s.Namespace)
			}
			o.p = savedPlugin{ID: o.f.ID, Service: name, Status: settingUp, Added: time.Now()}
		}
		o.p.Image, o.p.Name, o.p.Port = o.f.Image, o.f.Name, o.f.Port
		o.p.Address = o.p.address(o.f)
		if err := writePluginEnv(s.Dir, o.p.ID, o.f, o.values); err != nil {
			return "", err
		}
		if err := o.keepPlugin(false); err != nil { // (saved before anything is made: Remove finds it)
			return "", err
		}
		objects := kubePlugin(s, o.p, o.values, o.f)
		secret, rest, _ := strings.Cut(objects, "---\n")
		if _, err := kc("delete", "secret", o.p.Service, "--ignore-not-found"); err != nil {
			return "", err
		}
		args := []string{"-n", s.Namespace, "create", "-f", "-"}
		if s.Context != "" {
			args = append([]string{"--context", s.Context}, args...)
		}
		cmd := exec.CommandContext(ctx, "kubectl", args...)
		cmd.Stdin = strings.NewReader(secret)
		if out, err := cmd.CombinedOutput(); err != nil {
			return "", fmt.Errorf("kubectl create: %s", scrub(firstLine(strings.TrimSpace(string(out)))))
		}
		return o.p.Image, apply(rest)
	}) && step("Starting it", func() (string, error) {
		if o.what == "update" { // (the same tag, or only its settings changed: made again all the same)
			if _, err := kc("rollout", "restart", "deployment/"+o.p.Service); err != nil {
				return "", err
			}
		}
		_, err := kc("rollout", "status", "deployment/"+o.p.Service, "--timeout", "5m")
		return "", err
	})
	ok = ok && step("Letting the server reach it", tellServer) // (an update too)
	return ok && step("Checking it answers", func() (string, error) {
		args := []string{"-n", s.Namespace, "exec", "-i", server, "-c", "server", "--", "python", "-"}
		if s.Context != "" {
			args = append([]string{"--context", s.Context}, args...)
		}
		if err := checkPlugin(exec.Command("kubectl", args...), s.Dir, fill(o.p.Address, o.values)); err != nil {
			return "", err
		}
		o.p.Status = ""
		return "", o.keepPlugin(false)
	})
}

var errNotYet = errors.New("plugins aren't for this kind of server yet")

// ourKubePlugin is whether the objects by [name] are this server's (labelled with its slug), or
// there are none (false when it can't tell: nothing is deleted then).
func ourKubePlugin(s savedServer, name string) bool {
	for _, kind := range []string{"deployment", "service", "secret"} {
		owner, err := kubectlQuick(s.Context, "-n", s.Namespace, "get", kind+"/"+name, "--ignore-not-found", "-o", `jsonpath={.metadata.labels.app\.kubernetes\.io/instance}`)
		if err != nil {
			return false
		}
		if o := strings.TrimSpace(owner); o != "" && o != s.Slug {
			return false
		}
	}
	return true
}
