package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// Google Cloud, through gcloud: who's signed in, the billing accounts, making a project and turning
// Cloud Run on. The service itself goes through Cloud Run's own API, with gcloud's access token.

// gcloud runs gcloud for its output; a failure says why in Google's own words (its ERROR line).
func gcloud(ctx context.Context, args ...string) (string, error) {
	var kept []string
	for _, a := range args {
		if a != "" {
			kept = append(kept, a)
		}
	}
	cmd := exec.CommandContext(ctx, "gcloud", append(kept, "--quiet")...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil { // (stopped for taking too long: not gcloud's own words)
			return out.String(), errors.New("Google didn't answer in time")
		}
		return out.String(), errors.New(gcloudWhy(errb.String(), err))
	}
	return strings.TrimSpace(out.String()), nil
}

func gcloudQuick(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	return gcloud(ctx, args...)
}

func gcloudWhy(stderr string, err error) string {
	var last string
	for _, l := range strings.Split(stderr, "\n") {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, "ERROR:") {
			l = strings.TrimSpace(strings.TrimPrefix(l, "ERROR:"))
			if strings.HasPrefix(l, "(gcloud.") { // "(gcloud.projects.create) The project ID…"
				if _, rest, ok := strings.Cut(l, ") "); ok {
					l = rest
				}
			}
			return scrub(l)
		}
		if l != "" {
			last = l
		}
	}
	if last != "" {
		return scrub(last)
	}
	return err.Error()
}

// as is gcloud's flag for acting as [account] (its own default account left as it is).
func as(account string) string {
	if account == "" {
		return "" // (left out)
	}
	return "--account=" + account
}

// gcloudAccounts are the Google accounts gcloud is signed in with, its default one first.
func gcloudAccounts() []string {
	active, _ := gcloudQuick("config", "get-value", "account")
	if active == "(unset)" {
		active = ""
	}
	out, _ := gcloudQuick("auth", "list", "--format=value(account)")
	list := []string{}
	if active != "" {
		list = append(list, active)
	}
	for _, a := range strings.Fields(out) {
		if a != active {
			list = append(list, a)
		}
	}
	return list
}

type billingAccount struct{ id, name string }

// billingAccounts are the open billing accounts [account] can use.
func billingAccounts(account string) ([]billingAccount, error) {
	out, err := gcloudQuick("billing", "accounts", "list", "--filter=open=true", "--format=value(name,displayName)", as(account))
	if err != nil {
		return nil, err
	}
	var list []billingAccount
	for _, l := range strings.Split(out, "\n") {
		id, name, _ := strings.Cut(strings.TrimSpace(l), "\t")
		if id = strings.TrimPrefix(id, "billingAccounts/"); id != "" {
			list = append(list, billingAccount{id, name})
		}
	}
	return list, nil
}

// newProjectID is a fresh project ID: Google's IDs are global, so a random end keeps it free.
func newProjectID() string {
	const chars = "abcdefghijkmnpqrstuvwxyz23456789"
	b := make([]byte, 6)
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		b[i] = chars[n.Int64()]
	}
	return "nightcap-" + string(b)
}

// runAPI is Cloud Run's API for one project and region (its Knative-style services).
type runAPI struct{ project, region, token string }

// runBase is Cloud Run's API address (a test's own server, in tests).
var runBase = func(region string) string { return "https://" + region + "-run.googleapis.com" }

func newRunAPI(ctx context.Context, account, project, region string) (runAPI, error) {
	token, err := gcloud(ctx, "auth", "print-access-token", as(account))
	if err != nil {
		return runAPI{}, fmt.Errorf("gcloud couldn't sign in: %v (run gcloud auth login)", err)
	}
	return runAPI{project, region, token}, nil
}

func (r runAPI) url(name string) string {
	u := fmt.Sprintf("%s/apis/serving.knative.dev/v1/namespaces/%s/services", runBase(r.region), r.project)
	if name != "" {
		u += "/" + name
	}
	return u
}

// do sends [body] (if any), and gives the answer's JSON, or Google's reason it said no.
func (r runAPI) do(ctx context.Context, method, url string, body any) (map[string]any, int, error) {
	var rd io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		rd = bytes.NewReader(data)
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, url, rd)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+r.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("Google didn't answer: %v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	var out map[string]any
	_ = json.Unmarshal(data, &out)
	if resp.StatusCode >= 300 {
		why := resp.Status
		if e, ok := out["error"].(map[string]any); ok {
			if m, ok := e["message"].(string); ok && m != "" {
				why = m
			}
		}
		return out, resp.StatusCode, errors.New(scrub(why))
	}
	return out, resp.StatusCode, nil
}

// at reads a value down a JSON object's path ("status", "url").
func at(m map[string]any, path ...string) any {
	var v any = m
	for _, p := range path {
		o, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = o[p]
	}
	return v
}

func atString(m map[string]any, path ...string) string {
	s, _ := at(m, path...).(string)
	return s
}

// serviceReady reads a service's state: ready, still on its way, or why it can't start.
func serviceReady(svc map[string]any) (ready bool, why string) {
	gen, _ := at(svc, "metadata", "generation").(float64)
	seen, _ := at(svc, "status", "observedGeneration").(float64)
	conds, _ := at(svc, "status", "conditions").([]any)
	for _, c := range conds {
		cm, _ := c.(map[string]any)
		if cm["type"] != "Ready" {
			continue
		}
		msg, _ := cm["message"].(string)
		switch {
		case seen < gen:
			return false, ""
		case cm["status"] == "True":
			return true, ""
		case cm["status"] == "False":
			if msg == "" {
				msg = "it didn't start"
			}
			return false, scrub(msg)
		}
	}
	return false, ""
}

// projectMissing: Google's answer to describing a project that isn't theirs: none by that name,
// or someone else's ("does not have permission … (or it may not exist)").
func projectMissing(err error) bool {
	e := strings.ToLower(err.Error())
	return strings.Contains(e, "may not exist") || strings.Contains(e, "permission") || strings.Contains(e, "not found")
}
