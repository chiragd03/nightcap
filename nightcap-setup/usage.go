package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// What a server's screen shows beyond whether it runs: who's using it and its versions (the
// server's own owner API, with the owner key kept in its folder), and what it costs (on Google
// Cloud, from Google's usage numbers and list prices) or uses (at home, its CPU and memory).

// ownerInfo is the server's own account of itself, as its owner sees it.
type ownerInfo struct {
	households, profiles, devices int
	version, latest               string
	update                        bool
	aioVersion, aioTested         string
	aioOK                         bool
	hasAIO                        bool
}

// ownerKeyOf is the owner key kept in a server's folder (nightcap.env, or Kubernetes' secret.yaml).
func ownerKeyOf(dir string) string {
	for _, f := range []string{"nightcap.env", "secret.yaml"} {
		data, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			continue
		}
		for _, l := range strings.Split(string(data), "\n") {
			l = strings.TrimSpace(l)
			for _, sep := range []string{"OWNER_KEY=", "OWNER_KEY: "} {
				if v, ok := strings.CutPrefix(l, sep); ok {
					return strings.Trim(v, `'" `)
				}
			}
		}
	}
	return ""
}

// ownerClient follows no redirects: the owner key goes only to the server's own address.
var ownerClient = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

// ownerOf asks the server at [addr] about its households and versions, as its owner.
func ownerOf(addr, key string, wait time.Duration) (*ownerInfo, error) {
	if key == "" {
		return nil, fmt.Errorf("its owner key isn't in its folder")
	}
	get := func(path string, out any) error {
		ctx, cancel := context.WithTimeout(context.Background(), wait)
		defer cancel()
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(addr, "/")+path, nil)
		req.Header.Set("X-Owner-Key", key)
		resp, err := ownerClient.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("it answered %d", resp.StatusCode)
		}
		return json.NewDecoder(resp.Body).Decode(out)
	}
	var hh struct {
		Households []struct{ Profiles, Devices int }
	}
	if err := get("/server/households.json", &hh); err != nil {
		return nil, err
	}
	o := &ownerInfo{households: len(hh.Households)}
	for _, h := range hh.Households {
		o.profiles += h.Profiles
		o.devices += h.Devices
	}
	var v struct {
		Version, Latest string
		Update          bool
		AIOStreams      *struct {
			Version, Tested string
			OK              bool
		}
	}
	if get("/server/version.json", &v) == nil {
		o.version, o.latest, o.update = plainText(v.Version), plainText(v.Latest), v.Update
		if v.AIOStreams != nil {
			o.hasAIO, o.aioVersion, o.aioTested, o.aioOK = true, plainText(v.AIOStreams.Version), plainText(v.AIOStreams.Tested), v.AIOStreams.OK
		}
	}
	return o, nil
}

// Cloud Run's list prices (USD, request-based billing; Tier 2 regions' CPU and memory 1.4×) and its
// monthly free allowance, shared by every project on a billing account. Google takes the free
// allowance off as money at Tier 1 prices, so in a Tier 2 region it covers a little less use. Data
// out costs its region's price (1 GiB free from North America).
const (
	runVCPUs, runGiBs, runPerMRequests = 0.000024, 0.0000025, 0.40
	tier2VCPUs, tier2GiBs              = 0.0000336, 0.0000035
	freeVCPUs, freeGiBs, freeRequests  = 180_000, 360_000, 2_000_000
)

// cloudCost is this month's cost of a Google Cloud server: so far, and by the month's end at the
// last 7 days' pace.
type cloudCost struct {
	soFar, month float64
	cpuPct       float64 // of the free CPU allowance, so far
	sentGiB      float64
}

func costOf(s savedServer) (*cloudCost, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	api, err := newRunAPI(ctx, s.Account, s.Project, s.Region)
	if err != nil {
		return nil, err
	}
	// One copy's size: every container's limits added up.
	svc, _, err := api.do(ctx, http.MethodGet, api.url(s.Slug), nil)
	if err != nil {
		return nil, err
	}
	var cpu, mem float64
	containers, _ := at(svc, "spec", "template", "spec", "containers").([]any)
	for _, c := range containers {
		lim, _ := at(c.(map[string]any), "resources", "limits").(map[string]any)
		if v, err := strconv.ParseFloat(fmt.Sprint(lim["cpu"]), 64); err == nil {
			cpu += v
		}
		if m := fmt.Sprint(lim["memory"]); strings.HasSuffix(m, "Mi") {
			v, _ := strconv.ParseFloat(strings.TrimSuffix(m, "Mi"), 64)
			mem += v / 1024
		} else if strings.HasSuffix(m, "Gi") {
			v, _ := strconv.ParseFloat(strings.TrimSuffix(m, "Gi"), 64)
			mem += v
		}
	}
	now := time.Now().UTC()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	week := now.Add(-7 * 24 * time.Hour)
	days := 7.0 // (the pace of the last week, or of its life so far when younger)
	if !s.Created.IsZero() && s.Created.After(week) {
		week = s.Created.UTC()
		days = max(now.Sub(week).Hours()/24, 0.25)
	}
	metric := func(name string, from time.Time) (float64, error) {
		q := url.Values{
			"filter":                         {fmt.Sprintf(`metric.type="%s" AND resource.labels.service_name="%s"`, name, s.Slug)},
			"interval.startTime":             {from.Format(time.RFC3339)},
			"interval.endTime":               {now.Format(time.RFC3339)},
			"aggregation.alignmentPeriod":    {"2678400s"},
			"aggregation.perSeriesAligner":   {"ALIGN_DELTA"},
			"aggregation.crossSeriesReducer": {"REDUCE_SUM"},
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://monitoring.googleapis.com/v3/projects/"+s.Project+"/timeSeries?"+q.Encode(), nil)
		req.Header.Set("Authorization", "Bearer "+api.token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return 0, err
		}
		defer resp.Body.Close()
		var d struct {
			TimeSeries []struct {
				Points []struct {
					Value struct {
						Int64Value  string  `json:"int64Value"`
						DoubleValue float64 `json:"doubleValue"`
					}
				}
			}
			Error struct{ Message string }
		}
		if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
			return 0, err
		}
		if resp.StatusCode != http.StatusOK {
			return 0, fmt.Errorf("%s", scrub(orDefault(d.Error.Message, resp.Status)))
		}
		var sum float64
		for _, ts := range d.TimeSeries {
			for _, p := range ts.Points {
				if n, err := strconv.ParseFloat(p.Value.Int64Value, 64); err == nil {
					sum += n
				}
				sum += p.Value.DoubleValue
			}
		}
		return sum, nil
	}
	const billed, requests, sent = "run.googleapis.com/container/billable_instance_time", "run.googleapis.com/request_count", "run.googleapis.com/container/network/sent_bytes_count"
	vals := map[string]float64{}
	for _, m := range []struct {
		key, name string
		from      time.Time
	}{{"b", billed, start}, {"r", requests, start}, {"s", sent, start}, {"wb", billed, week}, {"wr", requests, week}, {"ws", sent, week}} {
		v, err := metric(m.name, m.from)
		if err != nil && strings.Contains(err.Error(), "has not been used") {
			if !s.MadeProject { // (a project of theirs: not changed from here)
				return nil, fmt.Errorf("Google's usage numbers are off in this project")
			}
			// Google's usage numbers aren't on in its own project yet: turned on (free), asked again.
			if _, err := gcloud(ctx, "services", "enable", "monitoring.googleapis.com", "--project="+s.Project, as(s.Account)); err == nil {
				v, err = metric(m.name, m.from)
			}
		}
		if err != nil {
			return nil, err
		}
		vals[m.key] = v
	}
	r, _ := regionByID(s.Region)
	vcpus, gibs, freeSent := runVCPUs, runGiBs, 0.0
	if r.tier == 2 {
		vcpus, gibs = tier2VCPUs, tier2GiBs
	}
	if r.area == "North America" {
		freeSent = 1
	}
	cost := func(req, sec, sentGiB float64) float64 {
		return math.Max(0, sec*cpu*vcpus-freeVCPUs*runVCPUs) + math.Max(0, sec*mem*gibs-freeGiBs*runGiBs) +
			math.Max(0, req-freeRequests)/1e6*runPerMRequests + math.Max(0, sentGiB-freeSent)*r.egress
	}
	gib := func(b float64) float64 { return b / (1 << 30) }
	end := start.AddDate(0, 1, 0)
	left := end.Sub(now).Hours() / 24
	c := &cloudCost{
		soFar:   cost(vals["r"], vals["b"], gib(vals["s"])),
		cpuPct:  vals["b"] * cpu * vcpus / (freeVCPUs * runVCPUs) * 100,
		sentGiB: gib(vals["s"]),
	}
	c.month = cost(vals["r"]+vals["wr"]/days*left, vals["b"]+vals["wb"]/days*left, gib(vals["s"]+vals["ws"]/days*left))
	return c, nil
}

// useOf is what a server at home is using: its containers' (or pods') CPU and memory, added up.
func useOf(s savedServer) (string, error) {
	switch s.Where {
	case "docker":
		ids, err := composeOut(s.Dir, "ps", "-q")
		if err != nil || strings.TrimSpace(ids) == "" {
			return "", err
		}
		out, err := runQuiet("docker", append([]string{"stats", "--no-stream", "--format", "{{.CPUPerc}} {{.MemUsage}}"}, strings.Fields(ids)...)...)
		if err != nil {
			return "", err
		}
		var cpu, mem float64
		for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
			f := strings.Fields(l)
			if len(f) < 2 {
				continue
			}
			v, _ := strconv.ParseFloat(strings.TrimSuffix(f[0], "%"), 64)
			cpu += v
			mem += bytesOf(f[1])
		}
		return fmt.Sprintf("CPU %.0f%% · memory %s", cpu, sizeOf(mem)), nil
	case "kubernetes":
		out, err := kubectlQuick(s.Context, "top", "pods", "-n", s.Namespace, "-l", kubeSelector(s.Slug), "--no-headers")
		if err != nil {
			return "", fmt.Errorf("the cluster doesn't report it (it needs metrics-server)")
		}
		var milli, mem float64
		for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
			f := strings.Fields(l)
			if len(f) < 3 {
				continue
			}
			v, _ := strconv.ParseFloat(strings.TrimSuffix(f[1], "m"), 64)
			milli += v
			mem += bytesOf(f[2])
		}
		return fmt.Sprintf("CPU %.2f cores · memory %s", milli/1000, sizeOf(mem)), nil
	}
	return "", nil
}

// bytesOf reads a size as Docker and kubectl write it ("412.3MiB", "128Mi", "1.2GiB").
func bytesOf(s string) float64 {
	units := []struct {
		suffix string
		mult   float64
	}{{"GiB", 1 << 30}, {"MiB", 1 << 20}, {"KiB", 1 << 10}, {"Gi", 1 << 30}, {"Mi", 1 << 20}, {"Ki", 1 << 10}, {"GB", 1e9}, {"MB", 1e6}, {"kB", 1e3}, {"B", 1}}
	for _, u := range units {
		if v, ok := strings.CutSuffix(s, u.suffix); ok {
			n, _ := strconv.ParseFloat(v, 64)
			return n * u.mult
		}
	}
	n, _ := strconv.ParseFloat(s, 64)
	return n
}

func sizeOf(b float64) string {
	if b >= 1<<30 {
		return fmt.Sprintf("%.1f GB", b/(1<<30))
	}
	return fmt.Sprintf("%.0f MB", b/(1<<20))
}

// money is a cost as people say it: "$0.21", "under a cent".
func money(v float64) string {
	if v < 0.005 {
		return "$0.00"
	}
	return fmt.Sprintf("$%.2f", v)
}
