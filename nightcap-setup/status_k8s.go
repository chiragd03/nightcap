package main

import (
	"encoding/json"
	"strings"
)

// A Kubernetes server's parts, as its pods have them: each by its component (db, aiostreams,
// server), running or not, and ready (healthy) or still starting.
func kubeParts(s savedServer) ([]part, string) {
	out, err := kubectlQuick(s.Context, "get", "pods", "-n", s.Namespace, "-l", kubeSelector(s.Slug), "-o", "json")
	if err != nil {
		return nil, err.Error()
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Labels            map[string]string `json:"labels"`
				DeletionTimestamp string            `json:"deletionTimestamp"`
			} `json:"metadata"`
			Status struct {
				Phase                 string                          `json:"phase"`
				Conditions            []struct{ Type, Status string } `json:"conditions"`
				InitContainerStatuses []struct {
					State struct {
						Waiting *struct{ Reason string } `json:"waiting"`
					} `json:"state"`
				} `json:"initContainerStatuses"`
			} `json:"status"`
		} `json:"items"`
	}
	if json.Unmarshal([]byte(out), &list) != nil {
		return nil, "the cluster's answer wasn't readable"
	}
	var parts []part
	for _, p := range list.Items {
		ready := false
		for _, c := range p.Status.Conditions {
			if c.Type == "Ready" && c.Status == "True" {
				ready = true
			}
		}
		pt := part{name: p.Metadata.Labels["app.kubernetes.io/component"], state: strings.ToLower(p.Status.Phase)}
		switch {
		case pt.state == "running" && ready:
			pt.health = "healthy"
		case pt.state == "running":
			pt.health = "starting"
		}
		for _, ic := range p.Status.InitContainerStatuses {
			if w := ic.State.Waiting; w != nil && w.Reason != "" && w.Reason != "PodInitializing" {
				pt.state, pt.health = "waiting for the database: "+w.Reason, "unhealthy"
			}
		}
		if p.Metadata.DeletionTimestamp != "" { // (going: stopped, or replaced by an update)
			pt.state, pt.health = "stopping", ""
		}
		parts = append(parts, pt)
	}
	return parts, ""
}
