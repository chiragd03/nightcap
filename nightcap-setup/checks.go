package main

import (
	"context"
	"encoding/json"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// What's on this computer: the tools each place to run Nightcap needs. Each is checked on its own,
// at the same time, with a short time limit (a tool that hangs isn't one that works).

type tool struct {
	name   string // as shown: "Docker"
	ok     bool
	ver    string // "27.3.1"
	detail string // "ready", "cluster: k3s-home", or why it isn't usable
	hint   string // what it's for, shown when there's room: "needed for Kubernetes"
}

const checkTimeout = 6 * time.Second

var versionRx = regexp.MustCompile(`\d+\.\d+(\.\d+)?`)

func run(ctx context.Context, name string, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, name, args...).Output()
	return strings.TrimSpace(string(out)), err
}

// checkDocker: installed, and its engine running (Docker Desktop can be installed but not started).
func checkDocker() tool {
	t := tool{name: "Docker"}
	if _, err := exec.LookPath("docker"); err != nil {
		t.detail = "not installed"
		return t
	}
	ctx, cancel := context.WithTimeout(context.Background(), checkTimeout)
	defer cancel()
	if v, err := run(ctx, "docker", "version", "--format", "{{.Server.Version}}"); err == nil && v != "" {
		t.ok, t.ver, t.detail = true, v, "ready"
		return t
	}
	v, _ := run(ctx, "docker", "version", "--format", "{{.Client.Version}}")
	t.ver, t.detail = v, "installed, but not running: start Docker"
	return t
}

// checkKubectl: installed, and pointed at a cluster.
func checkKubectl() tool {
	t := tool{name: "kubectl"}
	if _, err := exec.LookPath("kubectl"); err != nil {
		t.detail, t.hint = "not installed", "needed for Kubernetes"
		return t
	}
	ctx, cancel := context.WithTimeout(context.Background(), checkTimeout)
	defer cancel()
	if out, err := run(ctx, "kubectl", "version", "--client", "-o", "json"); err == nil {
		var v struct {
			ClientVersion struct{ GitVersion string } `json:"clientVersion"`
		}
		if json.Unmarshal([]byte(out), &v) == nil {
			t.ver = versionRx.FindString(v.ClientVersion.GitVersion)
		}
	}
	if c, err := run(ctx, "kubectl", "config", "current-context"); err == nil && c != "" {
		t.ok, t.detail = true, "cluster: "+c
		return t
	}
	t.detail = "installed, but no cluster chosen"
	return t
}

// checkGcloud: installed (signing in is asked for when Google Cloud is chosen).
func checkGcloud() tool {
	t := tool{name: "gcloud"}
	if _, err := exec.LookPath("gcloud"); err != nil {
		t.detail, t.hint = "not installed", "needed for Google Cloud"
		return t
	}
	ctx, cancel := context.WithTimeout(context.Background(), checkTimeout)
	defer cancel()
	// (Its own version, "550.0.0": the first line of gcloud --version, "Google Cloud SDK 550.0.0".)
	out, err := run(ctx, "gcloud", "--version")
	if err != nil {
		t.detail = "installed, but didn't answer"
		return t
	}
	first, _, _ := strings.Cut(out, "\n")
	t.ok, t.ver, t.detail = true, versionRx.FindString(first), "ready"
	return t
}

var checks = []func() tool{checkDocker, checkKubectl, checkGcloud}

// runQuiet runs a command with the usual time limit, for its output.
func runQuiet(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), checkTimeout)
	defer cancel()
	return run(ctx, name, args...)
}
