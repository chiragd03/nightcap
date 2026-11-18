package main

import (
	"bufio"
	"regexp"
	"strings"
	"testing"
)

func firstRegions(t *testing.T, tz string) []string {
	t.Helper()
	p, ok := placeOf(tz)
	if !ok {
		t.Fatalf("%s: not placed", tz)
	}
	var ids []string
	for _, r := range bestRegions(p, true) {
		ids = append(ids, r.id)
	}
	return ids
}

func TestBestRegions(t *testing.T) {
	for tz, want := range map[string]string{
		"Asia/Kolkata": "asia-south1", "Asia/Calcutta": "asia-south1", "America/Vancouver": "us-west1",
		"America/Toronto": "northamerica-northeast2", "America/Phoenix": "us-west4", "Europe/Amsterdam": "europe-west4",
		"America/Sao_Paulo": "southamerica-east1", "Asia/Tokyo": "asia-northeast1", "Asia/Beirut": "me-central1",
		"Africa/Cairo": "europe-west8", "Asia/Jerusalem": "me-west1", "Europe/London": "europe-west2",
		"America/New_York": "us-east4", "America/Mexico_City": "northamerica-south1",
	} {
		if got := firstRegions(t, tz); got[0] != want {
			t.Errorf("%s: %v, want %s first", tz, got, want)
		}
	}
	if got := firstRegions(t, "Asia/Kolkata"); got[1] != "asia-south2" {
		t.Errorf("India: Delhi second, got %v", got)
	}
	for _, tz := range []string{"Africa/Lagos", "Africa/Cairo"} {
		if got := firstRegions(t, tz); got[0] == "africa-south1" {
			t.Errorf("%s: Johannesburg first", tz)
		}
	}
	if got := firstRegions(t, "America/Bogota"); !strings.HasPrefix(got[0], "us-") && got[0] != "northamerica-south1" {
		t.Errorf("Bogotá: %v", got)
	}
	if got := firstRegions(t, "Australia/Perth"); !strings.HasPrefix(got[0], "australia-") {
		t.Errorf("Perth: %v", got)
	}
	var ids []string
	for _, r := range bestRegions(place{}, false) {
		ids = append(ids, r.id)
	}
	if strings.Join(ids, " ") != "us-central1 europe-west1 asia-south1" {
		t.Errorf("unknown place: %v", ids)
	}
	if _, ok := placeOf("UTC"); ok {
		t.Error("UTC placed")
	}
}

func TestRegionTable(t *testing.T) {
	seen := map[string]bool{}
	id := regexp.MustCompile(`^[a-z]+-[a-z]+[0-9]+$`)
	for _, r := range cloudRegions {
		if seen[r.id] || !id.MatchString(r.id) || r.tier < 1 || r.tier > 2 || r.egress == 0 {
			t.Errorf("bad region %+v", r)
		}
		seen[r.id] = true
	}
	if len(cloudRegions) != 42 {
		t.Errorf("%d regions", len(cloudRegions))
	}
	if regionName("europe-west1") != "Belgium" || regionName("asia-south1") != "Mumbai, India" {
		t.Error("labels")
	}
}

func TestWindowsZones(t *testing.T) {
	for _, c := range []struct{ name, cc, want string }{
		{"Eastern Standard Time", "CA", "America/Toronto"},
		{"Eastern Standard Time", "", "America/New_York"},
		{"Pacific Standard Time", "CA", "America/Vancouver"},
		{"India Standard Time", "IN", "Asia/Kolkata"},
		{"India Standard Time", "", "Asia/Kolkata"},
		{"Romance Standard Time", "ES", "Europe/Madrid"},
		{"W. Europe Standard Time", "NL", "Europe/Amsterdam"},
		{"UTC", "", ""},
	} {
		if got := windowsZone(c.name, c.cc); got != c.want {
			t.Errorf("%s + %q = %q, want %q", c.name, c.cc, got, c.want)
		}
	}
	p, _ := placeOf(windowsZone("Pacific Standard Time", "CA"))
	if r := bestRegions(p, true); r[0].id != "us-west1" {
		t.Errorf("Vancouver on Windows: %s", r[0].id)
	}
	// Every zone Windows can map to is one we can place.
	sc := bufio.NewScanner(strings.NewReader(windowsZonesTSV))
	for sc.Scan() {
		f := strings.Split(sc.Text(), "\t")
		if len(f) != 3 || strings.HasPrefix(f[2], "Etc/") || strings.HasPrefix(f[0], "#") {
			continue
		}
		if _, ok := placeOf(f[2]); !ok {
			t.Errorf("%s (%s) → %s: not in zone.tab", f[0], f[1], f[2])
		}
	}
}

func TestRegionScreen(t *testing.T) {
	c := cloudScreen{}
	c.toRegions()
	if n := len(c.list.opts); n != 4 || c.list.opts[0].badge != "Recommended" || c.list.opts[3].value != moreRegions {
		t.Fatalf("short list: %+v", c.list.opts)
	}
	c.list.cursor = 3
	c.enter()
	if !c.all || len(c.list.opts) != 42 || !c.list.compact {
		t.Fatalf("full list: %d", len(c.list.opts))
	}
	for _, w := range []int{76, 120} {
		v := c.View(w)
		for _, want := range []string{"North America", "Europe", "Belgium  ", "Mumbai, India"} {
			if !strings.Contains(ansi.ReplaceAllString(v, ""), want) {
				t.Errorf("width %d: no %q", w, want)
			}
		}
		if strings.Contains(ansi.ReplaceAllString(v, ""), "Belgium, Belgium") {
			t.Error("Belgium, Belgium")
		}
	}
	if !c.back() || c.all || len(c.list.opts) != 4 {
		t.Error("Esc from the full list goes back to the 3")
	}
}

func TestCostWords(t *testing.T) {
	t.Setenv("TZ", "") // (here() is worked out once; the words are checked through their parts)
	if r, _ := regionByID("asia-south1"); r.tier != 1 || r.egress != 0.12 {
		t.Error("Mumbai: Tier 1, the cheap rate")
	}
	if r, _ := regionByID("australia-southeast1"); r.tier != 2 || r.egress != 0.19 {
		t.Error("Sydney: Tier 2, the dear rate")
	}
}
