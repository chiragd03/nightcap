package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRemoveKubernetesSaysWhatGoes(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "kubernetes.yaml"), []byte("kind: StatefulSet\n"), 0o644)
	r := newRemoveScreen(savedServer{Name: "Test", Where: "kubernetes", Dir: dir, Namespace: "nightcap-test", MadeNamespace: true})
	v := r.View(90)
	for _, want := range []string{"its parts on the cluster", "Its database", "watch history", "nightcap-test, if nothing else is in it"} {
		if !strings.Contains(v, want) {
			t.Errorf("Remove doesn't say %q", want)
		}
	}
	if strings.Contains(v, "isn't touched") {
		t.Error("says a copy elsewhere isn't touched, for a Kubernetes server")
	}
}

func TestKubernetesServerScreen(t *testing.T) {
	s := savedServer{Name: "Test", Slug: "nightcap-test", Where: "kubernetes", Mode: "home", Dir: "/x/t", Address: "http://192.168.1.20:30171",
		Context: "k3s-home", Namespace: "nightcap-test"}
	m := serverModel(t, s)
	m, _ = m.Update(statusMsg{dir: s.Dir, st: serverStatus{parts: []part{{"db", "running", "healthy", 0}, {"server", "running", "healthy", 0}},
		answers: true, name: "Test", mode: "home", households: 0}})
	v := snap(t, m, "server-k8s")
	for _, want := range []string{"On Kubernetes  ·  k3s-home  ·  nightcap-test", "Logs", "Update", "Stop", "Remove"} {
		if !strings.Contains(v, want) {
			t.Errorf("doesn't show %q", want)
		}
	}
	// A crashing table step shows as unhealthy.
	m, _ = m.Update(statusMsg{dir: s.Dir, st: serverStatus{parts: []part{{"server", "tables: CrashLoopBackOff", "unhealthy", 0}}}})
	if v := snap(t, m, "server-k8s-crash"); !strings.Contains(v, "CrashLoopBackOff") || !strings.Contains(v, "Start") {
		t.Error("a crashing server isn't shown as such")
	}
}
