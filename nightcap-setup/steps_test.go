package main

import (
	"strings"
	"testing"
)

// Every target's steps, setting up and updating: each update shows its own steps, not a setup's.
func TestStepsEveryTarget(t *testing.T) {
	titles := func(d *deployer) string {
		var out []string
		for _, s := range d.steps() {
			out = append(out, s.title)
		}
		return strings.Join(out, " / ")
	}
	home := samplePlan("docker", "home", true)
	cases := []struct {
		name string
		d    *deployer
		want string
	}{
		{"docker setup", &deployer{here: true, b: bundle{plan: home}}, "Checking Docker / Writing the files / Getting the images / Starting the database / Starting Nightcap / Checking it answers"},
		{"docker update", &deployer{here: true, update: "Home"}, "Getting the newest images / Restarting Nightcap / Checking it answers"},
		{"kubernetes setup", &deployer{here: true, kube: true, b: bundle{plan: home}}, "Checking the cluster / Writing the files / Sending it to the cluster / Starting the database / Starting AIOStreams / Starting Nightcap / Checking it answers"},
		{"kubernetes update", &deployer{here: true, kube: true, update: "Home"}, "Getting the newest version / Starting Nightcap / Checking it answers"},
		{"files", &deployer{b: bundle{plan: home}}, "Writing the files"},
		{"cloud update", &deployer{here: true, cloud: true, update: "Home"}, "Getting the newest version / Starting it / Checking it answers"},
	}
	for _, c := range cases {
		if got := titles(c.d); got != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.name, got, c.want)
		}
	}
}

// The address saved: Google's on Google Cloud; a node's on a cluster (never this computer's).
func TestSavedAddress(t *testing.T) {
	p := samplePlan("kubernetes", "home", true)
	p.settings.address = ""
	p.kube.nodeIP = "192.168.1.20"
	if a := (&deployer{here: true, kube: true, b: bundle{plan: p}}).saved().Address; a != "http://192.168.1.20:30171" {
		t.Errorf("kubernetes: %q", a)
	}
	p.kube.nodeIP = ""
	if a := (&deployer{here: true, kube: true, b: bundle{plan: p}}).saved().Address; strings.Contains(a, "localhost") {
		t.Errorf("kubernetes with no node address saved as this computer's: %q", a)
	}
	if a := (&deployer{here: true, cloud: true, cloudURL: "https://x.run.app", b: bundle{plan: p}}).saved().Address; a != "https://x.run.app" {
		t.Errorf("cloud: %q", a)
	}
	d := samplePlan("docker", "home", true)
	d.settings.address = ""
	if a := (&deployer{here: true, b: bundle{plan: d}}).saved().Address; a != "http://localhost:7171" {
		t.Errorf("docker: %q", a)
	}
}
