package main

import (
	"strings"
	_ "time/tzdata" // (Windows has no tz zones of its own: to compare clocks)
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// windowsTimezone is Windows' time zone as a tz zone, placed by its Region setting's country (one
// Windows name covers many countries: "Eastern Standard Time" is Toronto's and New York's).
func windowsTimezone() string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\TimeZoneInformation`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	name, _, err := k.GetStringValue("TimeZoneKeyName")
	if err != nil {
		return ""
	}
	return windowsZone(strings.TrimRight(name, "\x00"), windowsCountry())
}

// windowsCountry is the Region setting's two-letter country ("" if not set).
func windowsCountry() string {
	buf := make([]uint16, 16)
	proc := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetUserDefaultGeoName")
	if proc.Find() == nil {
		if n, _, _ := proc.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf))); n > 0 {
			if cc := windows.UTF16ToString(buf); len(cc) == 2 {
				return strings.ToUpper(cc)
			}
		}
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, `Control Panel\International\Geo`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	if cc, _, err := k.GetStringValue("Name"); err == nil && len(cc) == 2 {
		return strings.ToUpper(cc)
	}
	return ""
}
