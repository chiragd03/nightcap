package main

import "strings"

// Where Nightcap runs, and who it's for. Each place is offered only when this computer has what
// it needs (the Welcome screen's checks); one that doesn't says why. Who it's for is asked only
// where both make sense: Google Cloud Run is always for people anywhere.

// plan is what the setup has chosen so far.
type plan struct {
	where    string // "docker", "kubernetes", "cloudrun"
	mode     string // "home" or "cloud" (the server's MODE)
	db       connPlan
	keys     keysPlan
	settings settingsPlan
	kube     kubePlan  // on Kubernetes: the cluster, namespace, pull secret
	cloud    cloudPlan // on Google Cloud: the project, billing, region
}

// connPlan is the database: its connection string (in memory only, never shown or logged) and,
// for showing, where it is ("db.example.com:5432/nightcap").
type connPlan struct {
	url, where string
	docker     *dockerDB // Postgres in Docker, made on the last step (url is then its address on Docker's network)
}

// whereChoices builds the list from what the checks found ([tools] in the checks' order: Docker,
// kubectl, gcloud; nil while one is still being checked), keeping the cursor where it was.
func whereChoices(tools []*tool, cursor int) choices {
	need := func(t *tool, what string) string {
		switch {
		case t == nil:
			return "Checking this computer…"
		case t.ok:
			return ""
		case strings.HasPrefix(t.detail, "not installed"):
			return "Needs " + what + ": install it, then come back."
		default:
			return strings.ToUpper(t.detail[:1]) + t.detail[1:] + "."
		}
	}
	cluster := "your cluster"
	if t := tools[1]; t != nil && strings.HasPrefix(t.detail, "cluster: ") {
		cluster = strings.TrimPrefix(t.detail, "cluster: ")
	}
	c := choices{cursor: cursor, later: "AWS, Fly.io, Railway"}
	c.opts = []option{
		{value: "docker", title: "This computer", why: need(tools[0], "Docker"), badge: "Recommended",
			desc: "Free, for your home. Your TVs find it on the Wi-Fi.\nRuns in Docker"},
		{value: "kubernetes", title: "My Kubernetes cluster", why: need(tools[1], "kubectl"),
			desc: "Free, for your home, on your own cluster.\n" + cluster},
		{value: "cloudrun", title: "Google Cloud", why: need(tools[2], "the Google Cloud CLI (gcloud)"),
			desc: "Reachable from anywhere. Usually free for a household.\nCloud Run; the cost is shown before anything is made"},
		{value: "files", title: "Another machine",
			desc: "Get the files, copy them to a NAS, VM or server, and start them there.\nAny machine with Docker"},
	}
	if !(len(tools) > 0 && tools[0] != nil && tools[0].ok) {
		c.opts[0].badge = ""
	}
	if c.opts[0].why == "" {
		if list, err := loadServers(); err == nil {
			for _, s := range list {
				if s.Where == "docker" {
					c.opts[0].why = "This computer already runs one (" + s.Name + "). Remove it first, or pick another place."
					c.opts[0].badge = ""
					break
				}
			}
		}
	}
	c.usable()
	return c
}

func audienceChoices(cursor int) choices {
	return choices{cursor: cursor, opts: []option{
		{value: "home", title: "Just my home", badge: "Recommended",
			desc: "TVs on your Wi-Fi find it. No codes to type."},
		{value: "cloud", title: "People anywhere",
			desc: "Friends and family join with an invite code.\nNeeds a web address (https://…)"},
	}}
}

var whereNames = map[string]string{"docker": "This computer (Docker)", "kubernetes": "Kubernetes", "cloudrun": "Google Cloud Run", "files": "Another machine (files to copy)"}
