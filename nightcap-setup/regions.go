package main

import (
	"bufio"
	_ "embed"
	"math"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// region is a place Cloud Run runs in.
type region struct {
	id, city, country, cc, area string
	lat, lon                    float64
	tier                        int     // Google's price tier for CPU and memory (2: about 40% dearer)
	egress                      float64 // USD per GiB sent to the internet (to most places)
}

// cloudRegions are all of Cloud Run's regions an ordinary account can use. To refresh: `gcloud run
// regions list` is the list (me-central2, Dammam, is left out: it's only for Saudi customers through
// CNTXT); tiers from Cloud Run's billing SKUs (africa-south1 is Tier 1 there, though the locations
// page says 2); data out from the network pricing page (per region it's sent from).
var cloudRegions = []region{
	{"us-central1", "Iowa", "USA", "US", "North America", 41.26, -95.86, 1, 0.12},
	{"us-east1", "South Carolina", "USA", "US", "North America", 33.20, -80.01, 1, 0.12},
	{"us-east4", "Virginia", "USA", "US", "North America", 39.04, -77.49, 1, 0.12},
	{"us-east5", "Columbus", "USA", "US", "North America", 39.96, -83.00, 1, 0.12},
	{"us-south1", "Dallas", "USA", "US", "North America", 32.78, -96.80, 1, 0.12},
	{"us-west1", "Oregon", "USA", "US", "North America", 45.60, -121.18, 1, 0.12},
	{"us-west2", "Los Angeles", "USA", "US", "North America", 34.05, -118.24, 2, 0.12},
	{"us-west3", "Salt Lake City", "USA", "US", "North America", 40.76, -111.89, 2, 0.12},
	{"us-west4", "Las Vegas", "USA", "US", "North America", 36.17, -115.14, 2, 0.12},
	{"northamerica-northeast1", "Montréal", "Canada", "CA", "North America", 45.50, -73.57, 2, 0.12},
	{"northamerica-northeast2", "Toronto", "Canada", "CA", "North America", 43.65, -79.38, 2, 0.12},
	{"northamerica-south1", "Querétaro", "Mexico", "MX", "North America", 20.59, -100.39, 1, 0.12},
	{"southamerica-east1", "São Paulo", "Brazil", "BR", "South America", -23.55, -46.63, 2, 0.19},
	{"southamerica-west1", "Santiago", "Chile", "CL", "South America", -33.45, -70.67, 2, 0.19},
	{"europe-west1", "Belgium", "Belgium", "BE", "Europe", 50.47, 3.82, 1, 0.12},
	{"europe-west2", "London", "UK", "GB", "Europe", 51.51, -0.13, 2, 0.12},
	{"europe-west3", "Frankfurt", "Germany", "DE", "Europe", 50.11, 8.68, 2, 0.12},
	{"europe-west4", "Netherlands", "Netherlands", "NL", "Europe", 53.44, 6.84, 1, 0.12},
	{"europe-west6", "Zurich", "Switzerland", "CH", "Europe", 47.38, 8.54, 2, 0.12},
	{"europe-west8", "Milan", "Italy", "IT", "Europe", 45.46, 9.19, 1, 0.12},
	{"europe-west9", "Paris", "France", "FR", "Europe", 48.86, 2.35, 1, 0.12},
	{"europe-west10", "Berlin", "Germany", "DE", "Europe", 52.52, 13.40, 2, 0.12},
	{"europe-west12", "Turin", "Italy", "IT", "Europe", 45.07, 7.69, 2, 0.12},
	{"europe-southwest1", "Madrid", "Spain", "ES", "Europe", 40.42, -3.70, 1, 0.12},
	{"europe-north1", "Finland", "Finland", "FI", "Europe", 60.57, 27.19, 1, 0.12},
	{"europe-north2", "Stockholm", "Sweden", "SE", "Europe", 59.33, 18.07, 1, 0.12},
	{"europe-central2", "Warsaw", "Poland", "PL", "Europe", 52.23, 21.01, 2, 0.12},
	{"me-west1", "Tel Aviv", "Israel", "IL", "Middle East", 32.09, 34.78, 1, 0.15},
	{"me-central1", "Doha", "Qatar", "QA", "Middle East", 25.29, 51.53, 2, 0.15},
	{"africa-south1", "Johannesburg", "South Africa", "ZA", "Africa", -26.20, 28.05, 1, 0.15},
	{"asia-south1", "Mumbai", "India", "IN", "Asia", 19.08, 72.88, 1, 0.12},
	{"asia-south2", "Delhi", "India", "IN", "Asia", 28.61, 77.21, 2, 0.12},
	{"asia-southeast1", "Singapore", "Singapore", "SG", "Asia", 1.35, 103.82, 2, 0.12},
	{"asia-southeast2", "Jakarta", "Indonesia", "ID", "Asia", -6.21, 106.85, 2, 0.19},
	{"asia-southeast3", "Bangkok", "Thailand", "TH", "Asia", 13.76, 100.50, 1, 0.12},
	{"asia-east1", "Taiwan", "Taiwan", "TW", "Asia", 24.05, 120.52, 1, 0.12},
	{"asia-east2", "Hong Kong", "Hong Kong", "HK", "Asia", 22.32, 114.17, 2, 0.12},
	{"asia-northeast1", "Tokyo", "Japan", "JP", "Asia", 35.68, 139.69, 1, 0.12},
	{"asia-northeast2", "Osaka", "Japan", "JP", "Asia", 34.69, 135.50, 1, 0.12},
	{"asia-northeast3", "Seoul", "South Korea", "KR", "Asia", 37.57, 126.98, 2, 0.19},
	{"australia-southeast1", "Sydney", "Australia", "AU", "Australia", -33.87, 151.21, 2, 0.19},
	{"australia-southeast2", "Melbourne", "Australia", "AU", "Australia", -37.81, 144.96, 2, 0.19},
}

// label is a region's name as people say it: "Mumbai, India", or "Belgium" once.
func (r region) label() string {
	if r.city == r.country {
		return r.city
	}
	return r.city + ", " + r.country
}

func regionByID(id string) (region, bool) {
	i := slices.IndexFunc(cloudRegions, func(r region) bool { return r.id == id })
	if i < 0 {
		return region{id: id, city: id, tier: 1, egress: 0.12}, false
	}
	return cloudRegions[i], true
}

func regionName(id string) string {
	r, _ := regionByID(id)
	return r.label()
}

// bestRegions are the 3 regions best for where this computer is: near it, cheaper by a little
// (Tier 1), in its own country by a little more. Somewhere unknown: one in each of the US, Europe
// and Asia.
func bestRegions(p place, known bool) []region {
	if !known {
		var out []region
		for _, id := range []string{"us-central1", "europe-west1", "asia-south1"} {
			r, _ := regionByID(id)
			out = append(out, r)
		}
		return out
	}
	score := func(r region) float64 {
		s := km(p.lat, p.lon, r.lat, r.lon)
		if r.tier == 2 {
			s += 600
		}
		if r.cc == p.cc {
			s -= 800
		}
		return s
	}
	var list []region
	for _, r := range cloudRegions {
		if r.id == "me-west1" && p.cc != "IL" && p.cc != "PS" {
			continue // (its neighbours mostly can't reach Israel: Doha or Milan instead)
		}
		list = append(list, r)
	}
	slices.SortStableFunc(list, func(a, b region) int { return int(math.Round(score(a) - score(b))) })
	return list[:3]
}

// km is the distance between two points on the earth.
func km(lat1, lon1, lat2, lon2 float64) float64 {
	rad := math.Pi / 180
	a := math.Pow(math.Sin((lat2-lat1)*rad/2), 2) + math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Pow(math.Sin((lon2-lon1)*rad/2), 2)
	return 6371 * 2 * math.Asin(math.Sqrt(a))
}

// costWords is what a Google Cloud server costs a month, roughly: one household's use is free;
// what's sent to it (posters, the stream finder) costs most, more in some parts of the world.
func costWords(regionID string) string {
	r, _ := regionByID(regionID)
	p, known := here()
	// (Google's cheapest rate is to North America, Europe and most of Asia.)
	near := known && (strings.HasPrefix(p.tz, "Europe/") || slices.Contains([]string{"US", "CA", "MX",
		"IN", "JP", "TW", "HK", "SG", "TH", "MY", "PH", "VN", "PK", "BD", "LK", "NP"}, p.cc))
	if r.tier == 1 && r.egress == 0.12 && near {
		return "about $1 a month"
	}
	return "about $1–2 a month"
}

// place is where this computer is, as its time zone says (it's never looked up online).
type place struct {
	tz, cc   string
	lat, lon float64
}

//go:embed data/zone.tab
var zoneTab string

// zones are tz zones' countries and coordinates (from zone.tab).
var zones = sync.OnceValue(func() map[string]place {
	out := map[string]place{}
	sc := bufio.NewScanner(strings.NewReader(zoneTab))
	for sc.Scan() {
		f := strings.Split(sc.Text(), "\t")
		if len(f) < 3 || strings.HasPrefix(f[0], "#") {
			continue
		}
		c := f[1] // ±DDMM±DDDMM or ±DDMMSS±DDDMMSS
		i := strings.IndexAny(c[1:], "+-") + 1
		out[f[2]] = place{tz: f[2], cc: f[0], lat: degrees(c[:i]), lon: degrees(c[i:])}
	}
	return out
})

func degrees(s string) float64 {
	sign := 1.0
	if s[0] == '-' {
		sign = -1
	}
	s = s[1:]
	d := 2
	if len(s) == 5 || len(s) == 7 {
		d = 3
	}
	deg, _ := strconv.Atoi(s[:d])
	min, _ := strconv.Atoi(s[d : d+2])
	sec := 0
	if len(s) > d+2 {
		sec, _ = strconv.Atoi(s[d+2:])
	}
	return sign * (float64(deg) + float64(min)/60 + float64(sec)/3600)
}

// oldZones are older names of tz zones (Windows and some systems still give them).
var oldZones = map[string]string{
	"Africa/Asmera": "Africa/Asmara", "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
	"America/Coral_Harbour": "America/Atikokan", "America/Godthab": "America/Nuuk",
	"America/Indianapolis": "America/Indiana/Indianapolis", "Asia/Calcutta": "Asia/Kolkata",
	"Asia/Katmandu": "Asia/Kathmandu", "Asia/Rangoon": "Asia/Yangon", "Asia/Saigon": "Asia/Ho_Chi_Minh",
	"Atlantic/Faeroe": "Atlantic/Faroe", "Europe/Kiev": "Europe/Kyiv", "Pacific/Enderbury": "Pacific/Kanton",
	"Pacific/Ponape": "Pacific/Pohnpei", "Pacific/Truk": "Pacific/Chuuk",
	"US/Eastern": "America/New_York", "US/Central": "America/Chicago", "US/Mountain": "America/Denver",
	"US/Pacific": "America/Los_Angeles", "US/Arizona": "America/Phoenix", "US/Alaska": "America/Anchorage",
	"US/Hawaii": "Pacific/Honolulu", "Canada/Eastern": "America/Toronto", "Canada/Pacific": "America/Vancouver",
	"Canada/Central": "America/Winnipeg", "Canada/Mountain": "America/Edmonton", "Canada/Atlantic": "America/Halifax",
	"America/Montreal": "America/Toronto", "Europe/Belfast": "Europe/London", "Asia/Istanbul": "Europe/Istanbul",
}

// placeOf is where a tz zone is (false when unknown, e.g. UTC).
func placeOf(tz string) (place, bool) {
	if n, ok := oldZones[tz]; ok {
		tz = n
	}
	p, ok := zones()[tz]
	return p, ok
}

// here is where this computer is.
var here = sync.OnceValues(func() (place, bool) { return placeOf(localTimezone()) })

//go:embed data/windowszones.tsv
var windowsZonesTSV string

// windowsZone is the tz zone of a Windows time zone name, in a country ("" if unknown): the
// country's own row, else the zone in that country nearest the name's usual one.
func windowsZone(name, cc string) string {
	rows := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(windowsZonesTSV))
	for sc.Scan() {
		f := strings.Split(sc.Text(), "\t")
		if len(f) == 3 && f[0] == name {
			rows[f[1]] = f[2]
		}
	}
	if z, ok := rows[cc]; ok && cc != "" {
		return canonicalZone(z)
	}
	base := canonicalZone(rows["001"])
	if from, ok := zones()[base]; ok && cc != "" && from.cc != cc {
		best, dist := "", math.Inf(1)
		for _, z := range zones() {
			if d := km(from.lat, from.lon, z.lat, z.lon); z.cc == cc && d < dist && sameClock(base, z.tz) {
				best, dist = z.tz, d
			}
		}
		if best != "" {
			return best
		}
	}
	if strings.HasPrefix(base, "Etc/") {
		return ""
	}
	return base
}

// sameClock is whether two zones kept the same time in winter and summer 2024 (fixed days: every
// version of the time zone data agrees on them, while places change their clocks later, e.g.
// British Columbia); true when unknown.
func sameClock(a, b string) bool {
	la, errA := time.LoadLocation(a)
	lb, errB := time.LoadLocation(b)
	if errA != nil || errB != nil {
		return true
	}
	for _, t := range []time.Time{time.Date(2024, 1, 15, 12, 0, 0, 0, time.UTC), time.Date(2024, 7, 15, 12, 0, 0, 0, time.UTC)} {
		_, oa := t.In(la).Zone()
		_, ob := t.In(lb).Zone()
		if oa != ob {
			return false
		}
	}
	return true
}

func canonicalZone(tz string) string {
	if n, ok := oldZones[tz]; ok {
		return n
	}
	return tz
}
