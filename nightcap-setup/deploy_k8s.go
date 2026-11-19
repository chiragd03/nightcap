package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Setting a server up on Kubernetes: the cluster checked, the files written, the Secret and the
// rest sent with kubectl apply, then each part waited for (the server's start makes the tables
// first), and the server asked, on a node's port 30171, whether it answers.

func newKubeDeployer(p plan) *deployer {
	b := makeBundle(p, false)
	dirFor := func(slug string) string { return filepath.Join(serversDir(), slug) }
	taken := takenSlugs(false)
	if out, err := kubectlQuick(p.kube.context, "get", "deployments", "-n", p.kube.namespace, "-o", "name"); err == nil {
		for _, l := range strings.Fields(out) {
			taken[strings.TrimSuffix(strings.TrimPrefix(l, "deployment.apps/"), "-server")] = true
		}
	}
	b.slug = uniqueSlug(b.slug, dirFor, taken)
	d := &deployer{dir: dirFor(b.slug), b: b, here: true, kube: true, out: make(chan deployMsg, 64)}
	d.secrets = []string{p.keys.tmdb, p.keys.ownerKey, p.keys.secretsKey, b.aioKey}
	if p.db.docker != nil {
		d.secrets = append(d.secrets, p.db.docker.password)
	} else if cfg, err := pgx.ParseConfig(normalizeURL(p.db.url)); err == nil && cfg.Password != "" {
		d.secrets = append(d.secrets, cfg.Password) // (a database it was given)
	}
	return d
}

// newKubeUpdater brings a server on Kubernetes up to date: its parts restarted (they pull the
// newest image), the server's start making the tables first, then asked whether it answers.
func newKubeUpdater(s savedServer) *deployer {
	d := &deployer{dir: s.Dir, here: true, kube: true, update: s.Name, out: make(chan deployMsg, 64), secrets: serverSecrets(s.Dir)}
	d.b.slug = s.Slug
	d.b.plan.kube = kubePlan{context: s.Context, namespace: s.Namespace, nodeIP: strings.TrimSuffix(strings.TrimPrefix(s.Address, "http://"), fmt.Sprintf(":%d", nodePort))}
	return d
}

func (d *deployer) runKube(ctx context.Context, step func(string, func() (string, error)) bool) {
	k := d.b.plan.kube
	if d.update != "" {
		_, _, serverName, _ := d.b.kubeNames()
		sel := kubeSelector(d.b.slug)
		ok := step("Getting the newest version", func() (string, error) {
			if n, err := kubectl(ctx, k.context, "-n", k.namespace, "get", "deployment/"+serverName, "-o", "jsonpath={.spec.replicas}"); err == nil && strings.TrimSpace(n) == "0" {
				return "", errors.New("it's stopped: start it first, then update it")
			}
			// (The server's own Deployments only: its plugins are updated from their own screen.)
			names, err := kubectl(ctx, k.context, "-n", k.namespace, "get", "deployment", "-l", sel, "-o", "name")
			if err != nil {
				return "", err
			}
			var own []string
			for _, n := range strings.Fields(names) {
				if !strings.Contains(n, "-plugin-") {
					own = append(own, n)
				}
			}
			if len(own) == 0 {
				return "", errors.New("its parts aren't on the cluster")
			}
			_, err = kubectl(ctx, k.context, append([]string{"-n", k.namespace, "rollout", "restart"}, own...)...)
			return "", err
		}) && step("Starting Nightcap", func() (string, error) {
			_, err := kubectl(ctx, k.context, "-n", k.namespace, "rollout", "status", "deployment/"+serverName, "--timeout", "8m")
			return "ready", err
		}) && step("Checking it answers", d.waitAnswers)
		if ok {
			d.say(deployMsg{step: -1, end: true})
		}
		return
	}
	dbName, aioName, serverName, _ := d.b.kubeNames()
	kc := func(args ...string) error {
		out, err := kubectl(ctx, k.context, args...)
		for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
			if l != "" {
				d.say(deployMsg{step: -1, line: l})
			}
		}
		return err
	}
	wait := func(what string, timeout time.Duration) (string, error) {
		return "ready", kc("-n", k.namespace, "rollout", "status", what, "--timeout", timeout.String())
	}
	ok := step("Checking the cluster", func() (string, error) {
		if _, err := kubectlQuick(k.context, "get", "nodes", "-o", "name"); err != nil {
			return "", errors.New("the cluster didn't answer: " + err.Error())
		}
		return k.context, nil
	}) && step("Writing the files", func() (string, error) {
		if err := d.b.write(d.dir); err != nil {
			return "", err
		}
		if f, err := os.OpenFile(filepath.Join(d.dir, "setup.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
			d.mu.Lock()
			d.log = f
			d.mu.Unlock()
			fmt.Fprintf(f, "\n--- %s ---\n", time.Now().Format(time.RFC3339))
		}
		return tildePath(d.dir), nil
	}) && func() bool { d.keep(); return true }() && step("Sending it to the cluster", func() (string, error) {
		if k.newNamespace {
			if err := kc("create", "namespace", k.namespace); err != nil && !strings.Contains(err.Error(), "AlreadyExists") {
				return "", err
			} else if err == nil {
				// (Made by this setup: marked, so Remove only ever takes away a namespace made for it.)
				d.madeNamespace = true
				_ = kc("annotate", "namespace", k.namespace, "nightcap-setup/made-for="+d.b.slug, "--overwrite")
				d.keep()
			}
			// (There already: one an earlier try made, or someone else's. Not marked either way.)
		}
		if clash := d.kubeClash(ctx); clash != "" {
			return "", fmt.Errorf("%s is already in %s, and isn't this server's. Go back and give this server another name", clash, k.namespace)
		}
		if err := kc("apply", "-f", filepath.Join(d.dir, "secret.yaml")); err != nil {
			return "", err
		}
		return "namespace " + k.namespace, kc("apply", "-f", filepath.Join(d.dir, "kubernetes.yaml"))
	})
	if ok && d.b.plan.db.docker != nil {
		ok = step("Starting the database", func() (string, error) { return wait("statefulset/"+dbName, 5*time.Minute) })
	}
	if ok && d.b.plan.keys.ownAIO {
		ok = step("Starting AIOStreams", func() (string, error) { return wait("deployment/"+aioName, 5*time.Minute) })
	}
	ok = ok && step("Starting Nightcap", func() (string, error) {
		return wait("deployment/"+serverName, 8*time.Minute)
	}) && step("Checking it answers", d.waitAnswers)
	if ok {
		d.say(deployMsg{step: -1, end: true})
	}
}

// kubeClash is the first object by one of this server's names that isn't its own ("" if none):
// applying would write over someone else's.
func (d *deployer) kubeClash(ctx context.Context) string {
	k := d.b.plan.kube
	for _, obj := range kubeObjects(d.b.slug) {
		out, err := kubectl(ctx, k.context, "get", obj, "-n", k.namespace, "--ignore-not-found",
			"-o", `jsonpath={.metadata.labels.app\.kubernetes\.io/instance}`)
		if err == nil && strings.TrimSpace(out) == "" {
			// (Not there, or there without labels: check which.)
			if there, _ := kubectl(ctx, k.context, "get", obj, "-n", k.namespace, "--ignore-not-found", "-o", "name"); strings.TrimSpace(there) != "" {
				return obj
			}
			continue
		}
		if err == nil && strings.TrimSpace(out) != d.b.slug {
			return obj
		}
	}
	return ""
}
