package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// A fake Cloud Run: services by name; POST answers 409 for a name that's there.
type fakeRun struct {
	mu       sync.Mutex
	services map[string]bool
	puts     int
}

func (f *fakeRun) start(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		name := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		switch {
		case r.Method == http.MethodGet && name == "services":
			var items []any
			for n := range f.services {
				items = append(items, map[string]any{"metadata": map[string]any{"name": n}})
			}
			json.NewEncoder(w).Encode(map[string]any{"items": items})
		case r.Method == http.MethodPost:
			var svc map[string]any
			json.NewDecoder(r.Body).Decode(&svc)
			n := atString(svc, "metadata", "name")
			if f.services[n] {
				w.WriteHeader(http.StatusConflict)
				w.Write([]byte(`{"error":{"message":"already exists"}}`))
				return
			}
			f.services[n] = true
			w.Write([]byte(`{"metadata":{"generation":1}}`))
		case r.Method == http.MethodGet:
			w.Write([]byte(`{"metadata":{"resourceVersion":"7"}}`))
		case r.Method == http.MethodPut:
			f.puts++
			w.Write([]byte(`{"metadata":{"generation":2}}`))
		case r.Method == http.MethodDelete:
			delete(f.services, name)
			w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(srv.Close)
	old := runBase
	runBase = func(string) string { return srv.URL }
	t.Cleanup(func() { runBase = old })
}

// A1: a service by the same name that this setup didn't send is never written over; one it sent
// itself (a Try again) is.
func TestNoOverwritingSomeoneElsesService(t *testing.T) {
	f := &fakeRun{services: map[string]bool{"nightcap": true}}
	f.start(t)
	d := &deployer{dir: t.TempDir(), here: true, cloud: true, b: bundle{slug: "nightcap"}, out: make(chan deployMsg, 64)}
	d.cs.api = runAPI{project: "p", region: "r", token: "t"}
	d.cs.svc = map[string]any{"metadata": map[string]any{"name": "nightcap"}}
	send := func() error {
		// (Only the sending step: the same code path runCloud runs.)
		var err error
		ok := d.sendStepForTest(context.Background(), &err)
		if !ok {
			return err
		}
		return nil
	}
	if err := send(); err == nil || !strings.Contains(err.Error(), "already has a service called nightcap") || f.puts != 0 {
		t.Fatalf("someone else's service: err %v, puts %d", err, f.puts)
	}
	f.services = map[string]bool{}
	d.cs.sent = false
	if err := send(); err != nil {
		t.Fatalf("a fresh name: %v", err)
	}
	if err := send(); err != nil || f.puts != 1 { // (Try again: its own, sent again)
		t.Errorf("its own, again: err %v, puts %d", err, f.puts)
	}
}

// R2-1: a project made for a server is kept when anything else is in it.
func TestProjectKeptWithOthersInIt(t *testing.T) {
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	f := &fakeRun{services: map[string]bool{"a": true, "b": true}}
	f.start(t)
	api := runAPI{project: "p", region: "r", token: "t"}
	s := savedServer{Slug: "a", Dir: "/x/a", Where: "cloudrun", Project: "p", MadeProject: true, Created: time.Now()}
	if why := projectNotOnlyItsOwn(context.Background(), api, s); !strings.Contains(why, "another service, b") {
		t.Errorf("another service: %q", why)
	}
	delete(f.services, "b")
	_ = saveServer(savedServer{Name: "Other", Slug: "c", Dir: "/x/c", Where: "cloudrun", Project: "p"})
	if why := projectNotOnlyItsOwn(context.Background(), api, s); !strings.Contains(why, "another server, Other") {
		t.Errorf("another saved server: %q", why)
	}
}

func TestProjectMissing(t *testing.T) {
	for msg, want := range map[string]bool{
		"The project ID you specified does not have permission to access this project (or it may not exist).": true,
		"Google didn't answer in time":                            false,
		"There was a problem refreshing your current auth tokens": false,
	} {
		if got := projectMissing(errors.New(msg)); got != want {
			t.Errorf("%q: %v", msg, got)
		}
	}
}

// sendStepForTest runs the sending step alone.
func (d *deployer) sendStepForTest(ctx context.Context, err *error) bool {
	_, *err = d.send(ctx)
	return *err == nil
}

// A Try again on a failed start on Google Cloud sends it again; elsewhere it starts where it failed.
func TestRetryFrom(t *testing.T) {
	p := samplePlan("cloudrun", "cloud", false)
	p.cloud = cloudPlan{newProject: true}
	d := &deployer{here: true, cloud: true, b: bundle{plan: p}}
	steps := d.steps()
	for i, s := range steps {
		want := i
		if s.title == "Starting Nightcap" {
			want = i - 1
		}
		if got := d.retryFrom(i); got != want {
			t.Errorf("%s: from %d, want %d", s.title, got, want)
		}
	}
	k := &deployer{here: true, kube: true, b: bundle{plan: samplePlan("kubernetes", "home", true)}}
	if k.retryFrom(5) != 5 {
		t.Error("Kubernetes moved its retry")
	}
}

// An earlier, unfinished try's name, folder and what it made are carried on, not copied again.
func TestCarryOn(t *testing.T) {
	p := samplePlan("cloudrun", "cloud", false)
	p.cloud = cloudPlan{project: "p1"}
	prev := &deployer{dir: "/x/home", kept: true, madeProject: true, b: bundle{slug: "home", plan: p}}
	prev.cs.sent = true
	d := &deployer{dir: "/x/home-2", b: bundle{slug: "home-2", plan: p}}
	d.carryOn(prev)
	if d.b.slug != "home" || d.dir != "/x/home" || !d.madeProject || !d.cs.sent {
		t.Errorf("not carried on: %+v", d)
	}
	other := p
	other.cloud.project = "p2"
	d2 := &deployer{dir: "/x/home-2", b: bundle{slug: "home-2", plan: other}}
	d2.carryOn(prev)
	if d2.b.slug != "home-2" {
		t.Error("carried on into another project")
	}
	untouched := &deployer{dir: "/x/new", b: bundle{slug: "new", plan: p}}
	untouched.carryOn(&deployer{b: bundle{slug: "home", plan: p}})
	if untouched.b.slug != "new" {
		t.Error("carried on from a try that made nothing")
	}
}
