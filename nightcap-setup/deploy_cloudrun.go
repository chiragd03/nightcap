package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Setting a server up on Google Cloud Run: the project made (if new) and put on its billing
// account, Cloud Run turned on, AIOStreams' place in the database made, the service sent, waited
// for, and asked whether it answers. Updating one: the newest server image sent, waited for, asked.

func newCloudDeployer(p plan) *deployer {
	b := makeBundle(p, false)
	dirFor := func(slug string) string { return filepath.Join(serversDir(), slug) }
	b.slug = uniqueSlug(cloudServiceName(b.slug), dirFor, takenSlugs(false))
	d := &deployer{dir: dirFor(b.slug), b: b, here: true, cloud: true, out: make(chan deployMsg, 64)}
	d.secrets = []string{p.keys.tmdb, p.keys.ownerKey, p.keys.secretsKey, b.aioKey}
	if cfg, err := pgx.ParseConfig(normalizeURL(p.db.url)); err == nil && cfg.Password != "" {
		d.secrets = append(d.secrets, cfg.Password)
	}
	return d
}

// newCloudUpdater brings a server on Google Cloud up to date: the newest server image.
func newCloudUpdater(s savedServer) *deployer {
	d := &deployer{dir: s.Dir, here: true, cloud: true, update: s.Name, out: make(chan deployMsg, 64), secrets: serverSecrets(s.Dir)}
	d.b.slug = s.Slug
	d.b.image = s.Image
	d.b.plan.cloud = cloudPlan{account: s.Account, project: s.Project, region: s.Region}
	d.cloudURL = s.Address
	return d
}

func (d *deployer) cloudSteps() []deployStep {
	if d.update != "" {
		return []deployStep{{title: "Getting the newest version"}, {title: "Starting it"}, {title: "Checking it answers"}}
	}
	s := []deployStep{{title: "Checking Google Cloud"}}
	s = append(s, deployStep{title: "Getting the project ready"})
	s = append(s, deployStep{title: "Turning on Cloud Run"})
	if d.b.plan.keys.ownAIO {
		s = append(s, deployStep{title: "Making the stream finder's database"})
	}
	return append(s, deployStep{title: "Writing the files"}, deployStep{title: "Sending it to Google"},
		deployStep{title: "Starting Nightcap"}, deployStep{title: "Checking it answers"})
}

func (d *deployer) runCloud(ctx context.Context, step func(string, func() (string, error)) bool) {
	c := d.b.plan.cloud
	service := d.b.slug
	if d.update != "" {
		ok := step("Getting the newest version", func() (string, error) {
			var err error
			if d.cs.api, err = newRunAPI(ctx, c.account, c.project, c.region); err != nil {
				return "", err
			}
			img, err := amd64Image(ctx, orDefault(d.b.image, serverImage()))
			if err != nil {
				return "", err
			}
			svc, _, err := d.cs.api.do(ctx, http.MethodGet, d.cs.api.url(service), nil)
			if err != nil {
				return "", err
			}
			containers, _ := at(svc, "spec", "template", "spec", "containers").([]any)
			for _, ct := range containers {
				if cm, _ := ct.(map[string]any); cm["name"] == "server" {
					if cm["image"] == img {
						return "already the newest", nil
					}
					cm["image"] = img
				}
			}
			// (A new revision only: no status sent back, and the old one's name dropped.)
			delete(svc, "status")
			if tm, _ := at(svc, "spec", "template", "metadata").(map[string]any); tm != nil {
				delete(tm, "name")
			}
			out, _, err := d.cs.api.do(ctx, http.MethodPut, d.cs.api.url(service), svc)
			if err != nil {
				return "", err
			}
			d.cs.gen, _ = at(out, "metadata", "generation").(float64)
			return shortDigest(img), nil
		}) && step("Starting it", func() (string, error) { return d.waitCloudReady(ctx, d.cs.api, service, d.cs.gen) }) &&
			step("Checking it answers", d.waitCloudAnswers)
		if ok {
			d.say(deployMsg{step: -1, end: true})
		}
		return
	}

	ok := step("Checking Google Cloud", func() (string, error) {
		cfg, err := pgx.ParseConfig(normalizeURL(d.b.plan.db.url))
		if err != nil {
			return "", errors.New("the database's address isn't one Postgres understands")
		}
		if !reachableFromGoogle(cfg.Host) {
			return "", fmt.Errorf("the database is at %s, which Google can't reach: give one on the internet (Supabase, Neon…)", cfg.Host)
		}
		if d.cs.api, err = newRunAPI(ctx, c.account, c.project, c.region); err != nil {
			return "", err
		}
		return c.account, nil
	})
	if ok {
		ok = step("Getting the project ready", func() (string, error) {
			// (Made on an earlier try: used, not made again.)
			if state, err := gcloud(ctx, "projects", "describe", c.project, "--format=value(lifecycleState)", as(c.account)); err != nil || state != "ACTIVE" {
				if _, err := gcloud(ctx, "projects", "create", c.project, "--name=Nightcap", as(c.account)); err != nil {
					if e := strings.ToLower(err.Error()); strings.Contains(e, "already") || strings.Contains(e, "in use") {
						return "", fmt.Errorf("the project name %s is taken by someone else. Go back and give the project another name", c.project)
					}
					return "", err
				}
				d.madeProject = true
				d.keep() // (on the list now: Remove can delete it even if a later step fails)
			}
			if on, _ := gcloud(ctx, "billing", "projects", "describe", c.project, "--format=value(billingAccountName)", as(c.account)); on != "" {
				return c.project, nil // (on billing already)
			}
			if _, err := gcloud(ctx, "billing", "projects", "link", c.project, "--billing-account="+c.billing, as(c.account)); err != nil {
				if strings.Contains(err.Error(), "FAILED_PRECONDITION") || strings.Contains(strings.ToLower(err.Error()), "quota") {
					return "", fmt.Errorf("the billing account %s already has as many projects as Google allows. Take one off it (console.cloud.google.com/billing → Account management), then choose Try again. The project %s is made and will be used",
						orDefault(c.billingName, c.billing), c.project)
				}
				return "", fmt.Errorf("couldn't put the project %s on the billing account: %v. Choose Try again", c.project, err)
			}
			return c.project, nil
		})
	}
	if ok {
		d.keep()
	}
	ok = ok && step("Turning on Cloud Run", func() (string, error) {
		wait, cancel := context.WithTimeout(ctx, 5*time.Minute)
		defer cancel()
		if _, err := gcloud(wait, "services", "enable", "run.googleapis.com", "--project="+c.project, as(c.account)); err != nil {
			return "", err
		}
		var err error
		d.cs.number, err = gcloud(ctx, "projects", "describe", c.project, "--format=value(projectNumber)", as(c.account))
		return "on", err
	})
	if ok && d.b.plan.keys.ownAIO {
		ok = step("Making the stream finder's database", func() (string, error) {
			wait, cancel := context.WithTimeout(ctx, time.Minute)
			defer cancel()
			if d.cs.aioRole == "" {
				// (A user of its own: one already there, another server's or an old one, is left as
				// it is, with its password; a fresh one is made, and the server sets households'
				// sources up again in it.)
				role, err := freeAIORole(wait, d.b.plan.db.url, aioRole(d.b.slug))
				if err != nil {
					return "", err
				}
				d.cs.aioRole = role
			}
			role, password := d.cs.aioRole, newSecret(32)
			d.secrets = append(d.secrets, password)
			var err error
			if d.cs.aioDB, err = aioDatabaseURI(withTLS(d.b.plan.db.url), role, password); err != nil {
				return "", err
			}
			return "its own user, " + role, makeAIODatabase(wait, d.b.plan.db.url, role, password)
		})
	}
	ok = ok && step("Writing the files", func() (string, error) {
		d.cloudURL = cloudPublicURL(service, d.cs.number, c.region)
		server, err := amd64Image(ctx, d.b.image)
		if err != nil {
			return "", err
		}
		aio, err := amd64Image(ctx, cloudAIOImage)
		if err != nil {
			return "", err
		}
		d.cs.svc = d.b.cloudService(service, server, aio, d.cloudURL, d.cs.aioDB)
		if err := os.MkdirAll(d.dir, 0o700); err != nil {
			return "", err
		}
		env := append(d.b.serverEnv(), [2]string{"AIOSTREAMS_DATABASE_URI", d.cs.aioDB})
		for _, f := range []struct {
			name, body string
			mode       os.FileMode
		}{
			{"service.json", jsonIndent(d.cs.svc), 0o600},
			{"nightcap.env", envFile("The Nightcap server's settings and keys (on Google Cloud Run: see service.json).", env), 0o600},
			{"README.md", d.b.cloudReadme(service), 0o644},
		} {
			if err := os.WriteFile(filepath.Join(d.dir, f.name), []byte(f.body), f.mode); err != nil {
				return "", err
			}
		}
		if f, err := os.OpenFile(filepath.Join(d.dir, "setup.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
			d.mu.Lock()
			d.log = f
			d.mu.Unlock()
			fmt.Fprintf(f, "\n--- %s ---\n", time.Now().Format(time.RFC3339))
		}
		return tildePath(d.dir), nil
	})
	ok = ok && step("Sending it to Google", func() (string, error) { return d.send(ctx) }) && step("Starting Nightcap", func() (string, error) { return d.waitCloudReady(ctx, d.cs.api, service, d.cs.gen) }) &&
		step("Checking it answers", d.waitCloudAnswers)
	if ok {
		d.say(deployMsg{step: -1, end: true})
	}
}

// waitCloudReady waits for the service's newest revision to be ready (a first start pulls the
// images: a few minutes at most).
func (d *deployer) waitCloudReady(ctx context.Context, api runAPI, service string, gen float64) (string, error) {
	until := time.Now().Add(8 * time.Minute)
	failures := 0
	for time.Now().Before(until) {
		svc, code, err := api.do(ctx, http.MethodGet, api.url(service), nil)
		if code == http.StatusUnauthorized { // (signed out by time: signed in again)
			if fresh, ferr := newRunAPI(ctx, d.b.plan.cloud.account, api.project, api.region); ferr == nil {
				api = fresh
			}
		}
		if err != nil {
			if failures++; failures >= 5 {
				return "", fmt.Errorf("Google didn't say how it's doing: %v", err)
			}
		} else {
			failures = 0
		}
		if err == nil {
			if g, _ := at(svc, "metadata", "generation").(float64); g >= gen {
				ready, why := serviceReady(svc)
				switch {
				case ready:
					if u := atString(svc, "status", "url"); u != "" && d.cloudURL == "" {
						d.cloudURL = u
					}
					return "ready", nil
				case why != "":
					return "", errors.New(why + " (its log: Google's console, Cloud Run, " + service + ", Logs)")
				}
			}
		}
		time.Sleep(4 * time.Second)
	}
	return "", errors.New("it didn't start in 8 minutes: see its log in Google's console, Cloud Run")
}

// waitCloudAnswers asks the server what joining it takes, until it answers (a first request
// starts a copy of it: some seconds).
func (d *deployer) waitCloudAnswers() (string, error) {
	url := strings.TrimRight(d.cloudURL, "/") + "/join/households.json"
	if d.update != "" {
		time.Sleep(3 * time.Second)
	}
	until := time.Now().Add(3 * time.Minute)
	var last int
	for time.Now().Before(until) {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		resp, err := http.DefaultClient.Do(req)
		cancel()
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return "it does", nil
			}
			last = resp.StatusCode
		}
		time.Sleep(3 * time.Second)
	}
	if last == http.StatusForbidden {
		return "", errors.New("Google won't let anyone reach it (403): a company account's policy may block public services; its admin can allow it")
	}
	return "", errors.New("Nightcap didn't answer in 3 minutes: see its log in Google's console (Cloud Run, Logs)")
}

func shortDigest(image string) string {
	if _, d, ok := strings.Cut(image, "@sha256:"); ok && len(d) >= 12 {
		return "sha256:" + d[:12]
	}
	return image
}

// send sends the service to Google: a new one, or (this setup's own, on a Try again) again.
func (d *deployer) send(ctx context.Context) (string, error) {
	c := d.b.plan.cloud
	service := d.b.slug
	// (A fresh sign-in each time: a Try again can come an hour later.)
	if api, err := newRunAPI(ctx, c.account, c.project, c.region); err == nil {
		d.cs.api = api
	} else if d.cs.api.token == "" {
		return "", err
	}
	// (Sent before: a new revision, so a start that failed is tried afresh.)
	if d.cs.sent {
		if tm, _ := at(d.cs.svc, "spec", "template", "metadata").(map[string]any); tm != nil {
			ann, _ := tm["annotations"].(map[string]any)
			if ann == nil {
				ann = map[string]any{}
				tm["annotations"] = ann
			}
			ann["nightcap-setup/try"] = time.Now().UTC().Format(time.RFC3339)
		}
	}

	if d.cs.api.token == "" { // (tried again in a new run of the steps)
		var err error
		if d.cs.api, err = newRunAPI(ctx, c.account, c.project, c.region); err != nil {
			return "", err
		}
	}
	// (Sent already, by an earlier try of this setup: a service by its name is its own.)
	wasSent := d.cs.sent
	d.cs.sent = true
	out, code, err := d.cs.api.do(ctx, http.MethodPost, d.cs.api.url(""), d.cs.svc)
	// (Cloud Run just turned on takes a minute or two to reach everywhere: waited for.)
	for wait := time.Now().Add(4 * time.Minute); err != nil && time.Now().Before(wait) &&
		(strings.Contains(err.Error(), "has not been used") || strings.Contains(err.Error(), "SERVICE_DISABLED") || strings.Contains(err.Error(), "it is disabled")); {
		d.say(deployMsg{step: -1, line: "Google is still turning Cloud Run on…"})
		time.Sleep(15 * time.Second)
		out, code, err = d.cs.api.do(ctx, http.MethodPost, d.cs.api.url(""), d.cs.svc)
	}
	if code == http.StatusConflict && !wasSent {
		// Someone else's service by this name (another setup, or one made by hand): never written over.
		return "", fmt.Errorf("the project already has a service called %s. Go back and give this server another name", service)
	}
	if code == http.StatusConflict { // (this setup's own, sent again)
		var old map[string]any
		if old, _, err = d.cs.api.do(ctx, http.MethodGet, d.cs.api.url(service), nil); err == nil {
			d.cs.svc["metadata"].(map[string]any)["resourceVersion"] = atString(old, "metadata", "resourceVersion")
			out, _, err = d.cs.api.do(ctx, http.MethodPut, d.cs.api.url(service), d.cs.svc)
		}
	}
	if err != nil {
		if strings.Contains(err.Error(), "invoker") || strings.Contains(strings.ToLower(err.Error()), "policy") {
			return "", fmt.Errorf("Google won't let it be public: %v. A company account's admin can allow it (the organization policy run.managed.requireInvokerIam)", err)
		}
		return "", err
	}
	d.cs.gen, _ = at(out, "metadata", "generation").(float64)
	return service + ", " + regionName(c.region), nil
}

// retryFrom is where Try again starts after step [at] failed: on Google Cloud a failed start is
// sent again (a new revision), as waiting again on the same one can only fail again.
func (d *deployer) retryFrom(at int) int {
	steps := d.steps()
	if d.cloud && at > 0 && at < len(steps) && steps[at].title == "Starting Nightcap" {
		return at - 1
	}
	return at
}
