package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// A server's state: each of its parts as Docker has it (running or not, healthy or not), whether
// the server answers and what it says (its name, how many households), and whether a newer image
// of it is out. For one run elsewhere ("Somewhere else"), only whether its address answers.

type part struct {
	name, state, health string // "server", "running", "healthy"
	exitCode            int
}

type serverStatus struct {
	parts      []part
	partsErr   string
	answers    bool
	answerErr  string
	name, mode string
	households int
	image      string
	newer      string // "yes", "no", or "" (couldn't tell)
	notAsked   bool   // whether it answers wasn't asked (a quiet look on Google Cloud: it would wake it)
	// A full look's extras (opening the screen, or r), kept through the quiet looks:
	owner    *ownerInfo // who's using it, its versions
	ownerErr string
	cost     *cloudCost // on Google Cloud
	costErr  string
	use      string // at home: its CPU and memory
	useErr   string
}

// parseComposePS reads docker compose ps's JSON: a list, or one object a line (it's been both).
func parseComposePS(out string) []part {
	type row struct {
		Service, State, Health string
		ExitCode               int
	}
	var rows []row
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		rows = nil
		sc := bufio.NewScanner(strings.NewReader(out))
		for sc.Scan() {
			var r row
			if json.Unmarshal([]byte(sc.Text()), &r) == nil && r.Service != "" {
				rows = append(rows, r)
			}
		}
	}
	var parts []part
	for _, r := range rows {
		parts = append(parts, part{name: r.Service, state: r.State, health: r.Health, exitCode: r.ExitCode})
	}
	return parts
}

// localAddress is where this computer reaches a server it runs.
func localAddress() string { return fmt.Sprintf("http://127.0.0.1:%d", serverPortN) }

// statusOf looks at a server; [newer] also asks the registry whether a newer image is out (slow,
// so not on every look).
func statusOf(s savedServer, newer bool) serverStatus {
	st := serverStatus{households: -1, image: s.Image}
	addr := s.Address
	if s.Where == "docker" {
		addr = localAddress()
		out, err := composeOut(s.Dir, "ps", "-a", "--format", "json")
		if err != nil {
			st.partsErr = err.Error()
		} else {
			st.parts = parseComposePS(out)
		}
		if newer {
			st.newer = newerImage(s.Image)
		}
	}
	if s.Where == "kubernetes" {
		st.parts, st.partsErr = kubeParts(s)
	}
	wait := 5 * time.Second
	if s.Where == "cloudrun" {
		st.parts, st.partsErr = cloudParts(s)
		wait = 30 * time.Second // (a first request after a quiet spell starts a copy of it)
		if !newer {
			st.notAsked = true // (a quiet look: Google's word only; asking it would start a copy)
			return st
		}
	}
	if addr == "" {
		st.answerErr = "no address saved"
		return st
	}
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(addr, "/")+"/join/households.json", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		st.answerErr = "nothing answered at " + addr
		return st
	}
	defer resp.Body.Close()
	var j struct {
		Server     string            `json:"server"`
		Mode       string            `json:"mode"`
		Households []json.RawMessage `json:"households"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&j) != nil {
		st.answerErr = fmt.Sprintf("it answered %d", resp.StatusCode)
		return st
	}
	st.answers, st.name, st.mode = true, j.Server, j.Mode
	if j.Mode == "home" {
		st.households = len(j.Households) // (a cloud server doesn't list them)
	}
	return st
}

// extras is what a full look adds, asked for beside the status (Google's numbers take a while).
type extras struct {
	dir      string
	owner    *ownerInfo
	ownerErr string
	cost     *cloudCost
	costErr  string
	use      string
	useErr   string
}

func extrasOf(s savedServer) extras {
	x := extras{dir: s.Dir}
	addr, wait := s.Address, 10*time.Second
	switch s.Where {
	case "docker":
		addr = localAddress()
	case "cloudrun":
		wait = 30 * time.Second
	}
	var err error
	if x.owner, err = ownerOf(addr, ownerKeyOf(s.Dir), wait); err != nil {
		x.ownerErr = err.Error()
	}
	switch s.Where {
	case "cloudrun":
		if x.cost, err = costOf(s); err != nil {
			x.costErr = err.Error()
		}
	case "docker", "kubernetes":
		if x.use, err = useOf(s); err != nil {
			x.useErr = err.Error()
		}
	}
	return x
}

func (st *serverStatus) take(x extras) {
	st.owner, st.ownerErr, st.cost, st.costErr, st.use, st.useErr = x.owner, x.ownerErr, x.cost, x.costErr, x.use, x.useErr
}

// newerImage says whether the registry has a newer [image] than the one here: "yes", "no", or ""
// when it can't tell (offline, not signed in to the registry, not pulled yet).
func newerImage(image string) string {
	here, err := runQuiet("docker", "image", "inspect", image, "--format", "{{range .RepoDigests}}{{println .}}{{end}}")
	if err != nil || here == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest}}").Output()
	if err != nil {
		return ""
	}
	var m struct{ Digest string }
	if json.Unmarshal(out, &m) != nil || m.Digest == "" {
		return ""
	}
	if strings.Contains(here, m.Digest) {
		return "no"
	}
	return "yes"
}

// composeOut runs docker compose in [dir], for its output (20 s: for looking).
func composeOut(dir string, args ...string) (string, error) {
	return composeFor(20*time.Second, dir, args...)
}

// composeLong is composeOut for what changes things (start, stop, restart, down): minutes, as a
// database waiting to be healthy, or a slow machine, can take them.
func composeLong(dir string, args ...string) (string, error) {
	return composeFor(5*time.Minute, dir, args...)
}

func composeFor(limit time.Duration, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", append([]string{"compose"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		msg := "docker compose " + args[0] + " didn't work"
		if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
			msg += ": " + scrub(firstLine(strings.TrimSpace(string(ee.Stderr))))
		}
		return "", fmt.Errorf("%s", msg)
	}
	return string(out), nil
}

// serverSecrets are the values in a server's env files that are keys or passwords, so they can be
// taken out of anything shown (logs).
func serverSecrets(dir string) []string {
	var out []string
	for _, f := range []string{"nightcap.env", ".env", "secret.yaml"} {
		data, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			continue
		}
		for _, l := range strings.Split(string(data), "\n") {
			sep := "="
			if f == "secret.yaml" {
				l, sep = strings.TrimSpace(l), ": "
			}
			k, v, ok := strings.Cut(l, sep)
			if !ok || strings.HasPrefix(k, "#") {
				continue
			}
			v = strings.Trim(v, `'"`)
			if strings.Contains(k, "KEY") || strings.Contains(k, "PASSWORD") || strings.Contains(k, "TOKEN") || strings.Contains(k, "DATABASE") {
				out = append(out, v)
				if i := strings.Index(v, "://"); i >= 0 { // a connection string's password, alone
					if at := strings.LastIndex(v, "@"); at > i {
						if _, pass, ok := strings.Cut(v[i+3:at], ":"); ok {
							out = append(out, pass)
						}
					}
				}
			}
		}
	}
	return out
}

// cloudParts is a Google Cloud server's state, as Cloud Run has it: its newest version ready, on its
// way, or failed (and why).
func cloudParts(s savedServer) ([]part, string) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	api, err := newRunAPI(ctx, s.Account, s.Project, s.Region)
	if err != nil {
		return nil, err.Error()
	}
	svc, _, err := api.do(ctx, http.MethodGet, api.url(s.Slug), nil)
	if err != nil {
		return nil, err.Error()
	}
	ready, why := serviceReady(svc)
	p := part{name: "server", state: "running", health: "starting"}
	switch {
	case ready:
		p.health = "healthy"
	case why != "":
		p.health = "unhealthy"
	}
	return []part{p}, why
}
