package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// On Google Cloud: a plugin is a Cloud Run service of its own, in its server's project and region,
// public (its token, in every path, keeps strangers out) and at most one small copy, none when no
// one's using it (the cap keeps the bill down too). The server reaches it at its https address, as
// it reaches any add-on: nothing to change on the server.

// cloudPluginName is the plugin's service name: the server's, then its ID, within Cloud Run's 49.
func cloudPluginName(slug, id string) string {
	tail := "-" + id
	name := cloudServiceName(slug + tail)
	if !strings.HasSuffix(name, tail) {
		name = cloudServiceName(strings.TrimRight(name[:max(0, 49-len(tail))], "-") + tail)
	}
	return name
}

// cloudPlugin is the plugin's service as Cloud Run's API takes it.
func cloudPlugin(s savedServer, p savedPlugin, image string, values map[string]string, f pluginFile) map[string]any {
	var env []any
	for _, st := range f.Settings {
		if v := values[st.Name]; v != "" {
			env = append(env, map[string]any{"name": st.Name, "value": v})
		}
	}
	// What its file asks for, or the defaults.
	memory, cpu, concurrency, maxScale, timeout := orDefault(f.Memory, "512Mi"), orDefault(f.CPU, "1"), f.Concurrency, f.MaxInstances, f.Timeout
	if concurrency == 0 {
		concurrency = 80
	}
	if maxScale == 0 {
		maxScale = 1
	}
	if timeout == 0 {
		timeout = 300
	}
	return map[string]any{
		"apiVersion": "serving.knative.dev/v1",
		"kind":       "Service",
		"metadata": map[string]any{
			"name":      p.Service,
			"namespace": s.Project,
			"labels":    map[string]any{"made-by": "nightcap-setup", "nightcap-server": s.Slug},
			"annotations": map[string]any{
				"run.googleapis.com/launch-stage":         "GA",
				"run.googleapis.com/invoker-iam-disabled": "true",
			},
		},
		"spec": map[string]any{
			"template": map[string]any{
				"metadata": map[string]any{"annotations": map[string]any{
					"autoscaling.knative.dev/maxScale":     fmt.Sprint(maxScale),
					"autoscaling.knative.dev/minScale":     "0",
					"run.googleapis.com/startup-cpu-boost": "true",
					"nightcap-setup/try":                   time.Now().UTC().Format(time.RFC3339), // (a new revision each time)
				}},
				"spec": map[string]any{
					"containerConcurrency": concurrency,
					"timeoutSeconds":       timeout,
					"containers": []any{map[string]any{
						"name":      "plugin",
						"image":     image,
						"ports":     []any{map[string]any{"containerPort": p.Port}}, // (Cloud Run sets PORT to it)
						"resources": map[string]any{"limits": map[string]any{"cpu": cpu, "memory": memory}},
						"env":       env,
					}},
				},
			},
		},
	}
}

func (o *pluginOp) runCloud(step stepFn) bool {
	s := o.s
	ctx := context.Background()
	var api runAPI
	signIn := func() error {
		var err error
		api, err = newRunAPI(ctx, s.Account, s.Project, s.Region)
		return err
	}
	if o.what == "remove" {
		return step("Stopping it", func() (string, error) {
			if err := signIn(); err != nil {
				return "", err
			}
			// Only a service this tool made for this server: one by its name that isn't is left alone.
			if !ourCloudService(ctx, api, o.p.Service, s.Slug) {
				return "not this server's: left as it is", nil
			}
			if _, code, err := api.do(ctx, http.MethodDelete, api.url(o.p.Service), nil); err != nil && code != http.StatusNotFound {
				return "", err
			}
			return "", nil
		}) && step("Telling the server", func() (string, error) {
			_ = os.Remove(pluginEnvPath(s.Dir, o.p.ID))
			return "nothing to change on it", o.keepPlugin(true)
		})
	}
	var svc map[string]any
	var gen float64
	var img string
	first := "Getting the image"
	if o.what == "update" {
		first = "Getting the newest image"
	}
	ok := step(first, func() (string, error) {
		if err := signIn(); err != nil {
			return "", err
		}
		var err error
		if img, err = amd64Image(ctx, o.f.Image); err != nil { // (its build for Google's machines, by digest)
			return "", err
		}
		if o.what == "add" {
			o.p = savedPlugin{ID: o.f.ID, Service: cloudPluginName(s.Slug, o.f.ID), Status: settingUp, Added: time.Now()}
			// (Checked before anything is saved: a name of someone else's is never taken on.)
			if _, code, _ := api.do(ctx, http.MethodGet, api.url(o.p.Service), nil); code != http.StatusNotFound && !ourCloudService(ctx, api, o.p.Service, s.Slug) {
				return "", fmt.Errorf("the project already has a service called %s that isn't this server's: rename the plugin's file (its name names the service)", o.p.Service)
			}
		}
		if o.what == "add" {
			o.p.Name, o.p.Port = o.f.Name, o.f.Port
		}
		if err := writePluginEnv(s.Dir, o.p.ID, o.f, o.values); err != nil {
			return "", err
		}
		if err := o.keepPlugin(false); err != nil { // (saved before anything is made: Remove finds it)
			return "", err
		}
		svc = cloudPlugin(s, savedPlugin{Service: o.p.Service, Port: o.f.Port}, img, o.values, o.f)
		return img, nil
	}) && step("Starting it", func() (string, error) {
		old, code, err := api.do(ctx, http.MethodGet, api.url(o.p.Service), nil)
		switch {
		case code == http.StatusNotFound:
			out, _, err := api.do(ctx, http.MethodPost, api.url(""), svc)
			if err != nil {
				return "", err
			}
			gen, _ = at(out, "metadata", "generation").(float64)
		case err != nil:
			return "", err
		default:
			// (One by its name that isn't this server's plugin is never written over.)
			if labels, _ := at(old, "metadata", "labels").(map[string]any); labels["made-by"] != "nightcap-setup" || labels["nightcap-server"] != s.Slug {
				return "", fmt.Errorf("the project already has a service called %s that isn't this server's", o.p.Service)
			}
			svc["metadata"].(map[string]any)["resourceVersion"] = atString(old, "metadata", "resourceVersion")
			out, _, err := api.do(ctx, http.MethodPut, api.url(o.p.Service), svc)
			if err != nil {
				return "", err
			}
			gen, _ = at(out, "metadata", "generation").(float64) // (its new revision's, not the last one's)
		}
		// Ready: its newest revision's.
		for until := time.Now().Add(6 * time.Minute); time.Now().Before(until); time.Sleep(4 * time.Second) {
			cur, _, err := api.do(ctx, http.MethodGet, api.url(o.p.Service), nil)
			if err != nil {
				continue
			}
			if g, _ := at(cur, "metadata", "generation").(float64); g < gen {
				continue
			}
			ready, why := serviceReady(cur)
			if why != "" {
				return "", errors.New(why + " (its log: Google's console, Cloud Run, " + o.p.Service + ", Logs)")
			}
			if ready {
				if u := atString(cur, "status", "url"); u != "" {
					o.p.Address = strings.TrimRight(u, "/") + o.f.Addon
				}
				// (Its new image, saved once it's what runs.)
				o.p.Image, o.p.Name, o.p.Port = img, o.f.Name, o.f.Port
				return "ready", o.keepPlugin(false)
			}
		}
		return "", errors.New("it didn't start in 6 minutes: see its log in Google's console, Cloud Run")
	})
	return ok && step("Checking it answers", func() (string, error) {
		if err := checkPublicPlugin(fill(o.p.Address, o.values)); err != nil {
			return "", err
		}
		o.p.Status = ""
		return "", o.keepPlugin(false)
	})
}

// checkPublicPlugin asks a plugin at its public address for its add-on, allowing for a cold start.
// Nothing of the address is said: it holds the plugin's token.
func checkPublicPlugin(address string) error {
	client := &http.Client{Timeout: 30 * time.Second}
	var last error
	for until := time.Now().Add(90 * time.Second); time.Now().Before(until); time.Sleep(3 * time.Second) {
		resp, err := client.Get(address)
		if err != nil {
			last = errors.New("no answer")
			continue
		}
		var m struct {
			ID string `json:"id"`
		}
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			last = fmt.Errorf("it answered %s", resp.Status)
			continue
		}
		if json.Unmarshal(data, &m) != nil || m.ID == "" {
			return errors.New("it answers, but not with an add-on: check its file's add-on path")
		}
		return nil
	}
	return fmt.Errorf("it didn't answer in 90 seconds (%v)", last)
}

// ourCloudService is whether the service by [name] is one this tool made for the server [slug]
// (false when it can't tell: nothing is deleted then).
func ourCloudService(ctx context.Context, api runAPI, name, slug string) bool {
	svc, code, err := api.do(ctx, http.MethodGet, api.url(name), nil)
	if code == http.StatusNotFound {
		return true // (none: nothing of anyone's to harm)
	}
	if err != nil {
		return false
	}
	labels, _ := at(svc, "metadata", "labels").(map[string]any)
	return labels["made-by"] == "nightcap-setup" && labels["nightcap-server"] == slug
}
