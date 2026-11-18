package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// Setting a server up: its files written, then (on this computer) its images pulled, its
// database started and its tables made, the server started, and asked whether it answers. Each
// step reports as it goes; the commands' output goes to the screen's log and to setup.log in the
// server's folder, with its keys and passwords taken out.

type stepState int

const (
	pending stepState = iota
	running
	done
	failed
)

type deployStep struct {
	title string
	state stepState
	note  string    // after it's done: "nightcap-db ready"
	began time.Time // when it started running
}

type deployMsg struct {
	step  int // which step this is about (-1: just a log line)
	state stepState
	note  string
	line  string // a line of output
	err   error  // the step failed: why
	end   bool   // all done
}

type deployer struct {
	dir      string
	b        bundle
	here     bool       // run it on this computer (else only write the files)
	kube     bool       // run it on a Kubernetes cluster
	cloud    bool       // run it on Google Cloud Run
	cloudURL string     // there: its address
	cs       cloudState // on Google Cloud: what each step made, kept for a try again
	// What this setup made itself (so Remove takes only that away), and whether it finished.
	madeProject, madeNamespace, finished bool
	kept                                 bool   // on the list: it has made something
	update                               string // updating this saved server (its name), rather than setting one up
	out                                  chan deployMsg
	secrets                              []string
	log                                  *os.File
	mu                                   sync.Mutex
}

// serversDir is where this tool keeps the servers it runs on this computer.
func serversDir() string { return filepath.Join(setupHome(), "servers") }

// filesDir is where the files for a server run elsewhere are written: a folder to copy, in the
// home folder (NIGHTCAP_FILES_HOME instead, for tests).
func filesDir(slug string) string {
	home := os.Getenv("NIGHTCAP_FILES_HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return filepath.Join(home, "nightcap-"+slug)
}

// keep puts a setup that has made something on the list, marked unfinished, so whatever it made
// can be found and removed even if it stops here. (Not for an update, or files for elsewhere.)
func (d *deployer) keep() {
	if d.update == "" && d.here {
		d.kept = true
		_ = saveServer(d.saved())
	}
}

// carryOn takes over what an earlier, unfinished try of this setup made (when the answers are
// changed after it): its name and folder, and what it made, so trying again uses them rather
// than making a second copy. Nothing it made is deleted.
func (d *deployer) carryOn(prev *deployer) {
	if prev == nil || !prev.kept || prev.finished || prev.b.plan.where != d.b.plan.where ||
		prev.b.plan.cloud.project != d.b.plan.cloud.project || prev.b.plan.kube.namespace != d.b.plan.kube.namespace {
		return
	}
	d.b.slug, d.dir = prev.b.slug, prev.dir
	d.kept, d.madeProject, d.madeNamespace = true, prev.madeProject, prev.madeNamespace
	d.cs.sent = prev.cs.sent
}

// saved is the server as the list keeps it.
func (d *deployer) saved() savedServer {
	p := d.b.plan
	// Its address: Google's; else a node's (on a cluster); else this computer's.
	addr := p.settings.address
	switch {
	case d.cloud:
		addr = d.cloudURL
	case addr == "" && d.kube && p.kube.nodeIP != "":
		addr = fmt.Sprintf("http://%s:%d", p.kube.nodeIP, nodePort)
	case addr == "" && d.here && !d.kube:
		addr = fmt.Sprintf("http://localhost:%d", serverPortN)
	}
	status := settingUp
	if d.finished {
		status = ""
	}
	own := ""
	if p.keys.ownAIO {
		own = d.b.ownAIOAddress()
	}
	return savedServer{Status: status, Name: p.settings.name, Slug: d.b.slug, Where: p.where, Mode: p.mode, Dir: d.dir,
		Address: addr, Image: d.b.image, Created: time.Now(), Context: p.kube.context, Namespace: p.kube.namespace,
		MadeNamespace: d.madeNamespace, Account: p.cloud.account, Project: p.cloud.project, Region: p.cloud.region, MadeProject: d.madeProject,
		OwnAIO: own}
}

func newDeployer(p plan) *deployer {
	if p.where == "kubernetes" {
		return newKubeDeployer(p)
	}
	if p.where == "cloudrun" {
		return newCloudDeployer(p)
	}
	here := p.where == "docker"
	b := makeBundle(p, here && hostNetHere() || !here)
	// (Its own name: one that's taken here gets -2, -3…, so another server's files and containers
	// are never written over.)
	dirFor := func(slug string) string { return filesDir(slug) }
	if here {
		dirFor = func(slug string) string { return filepath.Join(serversDir(), slug) }
	}
	b.slug = uniqueSlug(b.slug, dirFor, takenSlugs(here))
	dir := dirFor(b.slug)
	d := &deployer{dir: dir, b: b, here: here, out: make(chan deployMsg, 64)}
	d.secrets = []string{p.keys.tmdb, p.keys.ownerKey, p.keys.secretsKey, b.aioKey}
	if p.db.docker != nil {
		d.secrets = append(d.secrets, p.db.docker.password)
	}
	if u := p.db.url; u != "" {
		if i := strings.Index(u, "://"); i >= 0 {
			if at := strings.LastIndex(u, "@"); at > i {
				if _, pass, ok := strings.Cut(u[i+3:at], ":"); ok {
					d.secrets = append(d.secrets, pass)
				}
			}
		}
	}
	return d
}

// newUpdater brings a server this computer runs up to date: its newest images, its tables
// brought up to date, restarted, and asked whether it answers.
func newUpdater(s savedServer) *deployer {
	return &deployer{dir: s.Dir, here: true, update: s.Name, out: make(chan deployMsg, 64), secrets: serverSecrets(s.Dir)}
}

func (d *deployer) title() string {
	switch {
	case d.update != "":
		return "Updating " + d.update
	case !d.here:
		return "Writing the files"
	}
	return "Setting up Nightcap"
}

// steps are the titles the screen shows, in order.
func (d *deployer) steps() []deployStep {
	if d.cloud {
		return d.cloudSteps()
	}
	// (An update's own steps first: an update is also on a cluster, or here.)
	if d.update != "" && d.kube {
		return []deployStep{{title: "Getting the newest version"}, {title: "Starting Nightcap"}, {title: "Checking it answers"}}
	}
	if d.update != "" {
		return []deployStep{{title: "Getting the newest images"}, {title: "Restarting Nightcap"}, {title: "Checking it answers"}}
	}
	if d.kube {
		s := []deployStep{{title: "Checking the cluster"}, {title: "Writing the files"}, {title: "Sending it to the cluster"}}
		if d.b.plan.db.docker != nil {
			s = append(s, deployStep{title: "Starting the database"})
		}
		if d.b.plan.keys.ownAIO {
			s = append(s, deployStep{title: "Starting AIOStreams"})
		}
		return append(s, deployStep{title: "Starting Nightcap"}, deployStep{title: "Checking it answers"})
	}
	if !d.here {
		return []deployStep{{title: "Writing the files"}}
	}
	s := []deployStep{{title: "Checking Docker"}, {title: "Writing the files"}, {title: "Getting the images"}}
	if d.b.plan.db.docker != nil {
		s = append(s, deployStep{title: "Starting the database"})
	}
	return append(s, deployStep{title: "Starting Nightcap"}, deployStep{title: "Checking it answers"})
}

// listen waits for the next thing the deploy says (Bubble Tea's way of hearing from a goroutine).
func (d *deployer) listen() tea.Cmd {
	return func() tea.Msg { return <-d.out }
}

func (d *deployer) scrub(s string) string {
	for _, x := range d.secrets {
		if len(x) >= 4 {
			s = strings.ReplaceAll(s, x, "•••")
		}
	}
	return scrub(s)
}

func (d *deployer) say(m deployMsg) {
	if m.line != "" {
		m.line = d.scrub(m.line)
		d.mu.Lock()
		if d.log != nil {
			fmt.Fprintln(d.log, m.line)
		}
		d.mu.Unlock()
	}
	d.out <- m
}

// run does every step from [from] on, stopping at the first that fails.
func (d *deployer) run(from int) {
	n := 0
	step := func(title string, fn func() (string, error)) bool {
		i := n
		n++
		if i < from {
			return true
		}
		d.say(deployMsg{step: i, state: running, line: "· " + title})
		note, err := fn()
		if err != nil {
			d.say(deployMsg{step: i, state: failed, err: err, line: "✗ " + err.Error()})
			return false
		}
		d.say(deployMsg{step: i, state: done, note: note})
		return true
	}
	ctx := context.Background()
	if d.cloud {
		d.runCloud(ctx, step)
		return
	}
	if d.kube {
		d.runKube(ctx, step)
		return
	}
	if d.update != "" {
		if d.log == nil {
			if f, err := os.OpenFile(filepath.Join(d.dir, "setup.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
				d.log = f
				fmt.Fprintf(f, "\n--- update %s ---\n", time.Now().Format(time.RFC3339))
			}
		}
		_ = step("Getting the newest images", func() (string, error) { return "", d.compose(ctx, "pull", "--quiet") }) &&
			step("Restarting Nightcap", func() (string, error) { return "", d.compose(ctx, "up", "-d") }) &&
			step("Checking it answers", d.waitAnswers) &&
			func() bool { d.say(deployMsg{step: -1, end: true}); return true }()
		return
	}
	if d.here && !step("Checking Docker", d.checkDocker) {
		return
	}
	if !step("Writing the files", d.writeFiles) {
		return
	}
	d.keep()
	if !d.here {
		d.say(deployMsg{step: -1, end: true})
		return
	}
	if !step("Getting the images", func() (string, error) { return "", d.compose(ctx, "pull", "--quiet") }) {
		return
	}
	if db := d.b.plan.db.docker; db != nil {
		if !step("Starting the database", func() (string, error) {
			if err := d.compose(ctx, "up", "-d", "db"); err != nil {
				return "", err
			}
			wait, cancel := context.WithTimeout(ctx, 2*time.Minute)
			defer cancel()
			return "ready", db.waitReady(wait, db.hostURL())
		}) {
			return
		}
	}
	if !step("Starting Nightcap", func() (string, error) { return "", d.compose(ctx, "up", "-d") }) {
		return
	}
	if !step("Checking it answers", d.waitAnswers) {
		return
	}
	d.say(deployMsg{step: -1, end: true})
}

func (d *deployer) checkDocker() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), checkTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "compose", "version", "--short").Output()
	if err != nil {
		return "", errors.New("Docker Compose isn't here: it comes with Docker Desktop, or install docker-compose-plugin")
	}
	if !free(serverPortN) && !d.ownContainers(ctx) {
		return "", fmt.Errorf("port %d is in use on this computer (another Nightcap?). Stop that first", serverPortN)
	}
	return "Compose " + strings.TrimSpace(string(out)), nil
}

func (d *deployer) writeFiles() (string, error) {
	if err := d.b.write(d.dir); err != nil {
		return "", err
	}
	f, err := os.OpenFile(filepath.Join(d.dir, "setup.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err == nil {
		d.mu.Lock()
		d.log = f
		d.mu.Unlock()
		fmt.Fprintf(f, "\n--- %s ---\n", time.Now().Format(time.RFC3339))
	}
	return tildePath(d.dir), nil
}

// compose runs docker compose in the server's folder, its output going to the log line by line.
func (d *deployer) compose(ctx context.Context, args ...string) error {
	cmd := exec.CommandContext(ctx, "docker", append([]string{"compose"}, args...)...)
	cmd.Dir = d.dir
	r, w := io.Pipe()
	cmd.Stdout, cmd.Stderr = w, w
	var last []string
	lines := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(r)
		for sc.Scan() {
			l := strings.TrimSpace(sc.Text())
			if l == "" {
				continue
			}
			last = append(last, l)
			if len(last) > 3 {
				last = last[1:]
			}
			d.say(deployMsg{step: -1, line: l})
		}
		close(lines)
	}()
	err := cmd.Run()
	w.Close()
	<-lines
	if err != nil {
		why := "docker compose " + args[0] + " didn't work"
		if len(last) > 0 {
			why += ": " + d.scrub(last[len(last)-1])
		}
		return errors.New(why)
	}
	return nil
}

// waitAnswers asks the server what joining it takes, until it answers (it's up) or two minutes pass.
func (d *deployer) waitAnswers() (string, error) {
	url := fmt.Sprintf("http://127.0.0.1:%d/join/households.json", serverPortN)
	if d.kube {
		url = fmt.Sprintf("http://%s:%d/join/households.json", d.b.plan.kube.nodeIP, nodePort)
	}
	// (Updating: the one answering may still be the old one; the new one has to as well. A few
	// seconds' wait, then asked.)
	if d.update != "" {
		time.Sleep(3 * time.Second)
	}
	until := time.Now().Add(2 * time.Minute)
	for time.Now().Before(until) {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		resp, err := http.DefaultClient.Do(req)
		cancel()
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return "it does", nil
			}
		}
		time.Sleep(2 * time.Second)
	}
	if d.kube {
		// (Not reachable from here: is it running? Asked through the cluster, and on this computer,
		// where Docker Desktop's cluster puts its ports.)
		k := d.b.plan.kube
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if _, err := kubectl(ctx, k.context, "get", "--raw", "/api/v1/namespaces/"+k.namespace+"/services/"+d.b.slug+"-server:http/proxy/join/households.json"); err == nil {
			for _, u := range []string{fmt.Sprintf("http://127.0.0.1:%d/join/households.json", nodePort)} {
				if r, err := http.Get(u); err == nil && r.StatusCode == http.StatusOK {
					r.Body.Close()
					d.b.plan.kube.nodeIP = "127.0.0.1"
					return "it does, on this computer", nil
				}
			}
			return fmt.Sprintf("it runs, but this computer can't reach %s:%d (TVs need to)", k.nodeIP, nodePort), nil
		}
		return "", errors.New("Nightcap didn't answer in 2 minutes: see its log (Manage, then Logs)")
	}
	return "", errors.New("Nightcap didn't answer in 2 minutes: see its log with docker compose logs server, in " + tildePath(d.dir))
}

// tildePath shows a path under the home folder as ~/…
func tildePath(p string) string {
	if home, err := os.UserHomeDir(); err == nil && strings.HasPrefix(p, home) {
		return "~" + strings.TrimPrefix(p, home)
	}
	return p
}

// ownContainers: this server's own containers are there (an earlier try of it holds its port).
func (d *deployer) ownContainers(ctx context.Context) bool {
	out, err := exec.CommandContext(ctx, "docker", "compose", "-p", d.b.slug, "ps", "-q").Output()
	return err == nil && strings.TrimSpace(string(out)) != ""
}
