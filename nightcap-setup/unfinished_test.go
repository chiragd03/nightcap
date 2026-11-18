package main

import (
	"strings"
	"testing"
	"time"
)

// A setup that has made something is on the list, unfinished, with only what it made itself;
// finished, it's marked done. An update never writes over the entry.
func TestUnfinishedIsKept(t *testing.T) {
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	p := samplePlan("cloudrun", "cloud", false)
	p.cloud = cloudPlan{account: "me@example.com", project: "theirs-1", newProject: true, region: "us-east1"}
	d := &deployer{dir: t.TempDir(), here: true, cloud: true, b: bundle{slug: "home", plan: p}}
	d.keep()
	list, _ := loadServers()
	if len(list) != 1 || list[0].Status != settingUp || list[0].MadeProject {
		t.Fatalf("after the first step: %+v", list)
	}
	// (The plan said new, but nothing was made by this run: not MadeProject.)
	d.madeProject = true
	d.keep()
	if list, _ := loadServers(); !list[0].MadeProject {
		t.Error("a project this run made isn't recorded")
	}
	d.finished = true
	_ = saveServer(d.saved())
	if list, _ := loadServers(); len(list) != 1 || list[0].Status != "" {
		t.Errorf("finished: %+v", list)
	}
	up := &deployer{dir: d.dir, here: true, cloud: true, update: "Home"}
	up.keep()
	if list, _ := loadServers(); len(list) != 1 || list[0].Project != "theirs-1" {
		t.Errorf("an update wrote over the entry: %+v", list)
	}
}

// Manage: an unfinished one says so, and offers only Remove and Forget; Forget takes it off the list.
func TestUnfinishedInManage(t *testing.T) {
	s := savedServer{Status: settingUp, Name: "Half", Slug: "half", Where: "cloudrun", Mode: "cloud", Dir: "/x/half", Project: "p", Region: "us-east1", Created: time.Now()}
	if l := lineOf(s); !strings.Contains(l.text, "didn't finish") {
		t.Errorf("list line: %q", l.text)
	}
	m := serverModel(t, s)
	a := m.(app)
	var vals []string
	for _, o := range a.server.actions.opts {
		vals = append(vals, o.value)
	}
	if strings.Join(vals, ",") != "remove,forget" {
		t.Errorf("actions: %v", vals)
	}
	if v := m.View(); !strings.Contains(v, "Its setup didn't finish") {
		t.Error("the screen doesn't say it didn't finish")
	}
	m = press(m, "down", "enter")
	if a := m.(app); a.screen != manageScreenID || len(a.servers) != 0 || !strings.Contains(a.manageNote, "taken off the list") {
		t.Errorf("Forget: screen %d, %d servers, note %q", a.screen, len(a.servers), a.manageNote)
	}
}
