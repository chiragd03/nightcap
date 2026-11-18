package main

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// A list to choose one from, each with a line or two saying what it means. One that can't be
// chosen here is shown dim with why, and the cursor steps over it.

type option struct {
	value string
	title string
	desc  string // a short line; a second ("\n" between) is the detail for those who want it, dim
	why   string // why it can't be chosen here ("" if it can)
	badge string // a tag by the title ("Recommended")
	group string // in a compact list: the heading it's under ("Europe")
}

type choices struct {
	opts    []option
	cursor  int
	later   string // a dim line under a rule: what's coming ("AWS, Fly.io, Railway")
	compact bool   // one line each (a long list), under their groups' headings; desc dim beside
}

// usable puts the cursor on a choice that can be chosen, from where it is (it may have become
// unusable since, or the list changed).
func (c *choices) usable() {
	for i := 0; i < len(c.opts); i++ {
		if j := (c.cursor + i) % len(c.opts); c.opts[j].why == "" {
			c.cursor = j
			return
		}
	}
}

func (c *choices) move(by int) {
	for i := 1; i <= len(c.opts); i++ {
		j := ((c.cursor+by*i)%len(c.opts) + len(c.opts)) % len(c.opts)
		if c.opts[j].why == "" {
			c.cursor = j
			return
		}
	}
}

func (c choices) chosen() (option, bool) {
	if c.cursor < 0 || c.cursor >= len(c.opts) || c.opts[c.cursor].why != "" {
		return option{}, false
	}
	return c.opts[c.cursor], true
}

// view draws the list: each choice a title (and its tag), a short line under it, and the chosen
// one marked by a gold bar down its left.
func (c choices) view(width int) string {
	var rows []string
	textW := max(width-4, 20)
	for i, o := range c.opts {
		bar, title, line := "  ", plain.Bold(true).Render(o.title), plain
		desc := o.desc
		switch {
		case o.why != "":
			title, desc, line = muted.Render(o.title), o.why, muted
		case i == c.cursor:
			bar, title = accent.Render("┃ "), accentB.Render(o.title)
		}
		if o.badge != "" && o.why == "" {
			title += "  " + badge(o.badge)
		}
		if c.compact {
			if desc != "" {
				title += "  " + muted.Render(desc)
			}
			if o.group != "" && (i == 0 || c.opts[i-1].group != o.group) {
				if i > 0 {
					rows = append(rows, "")
				}
				rows = append(rows, "  "+muted.Render(o.group))
			}
			rows = append(rows, bar+title)
			continue
		}
		lines := []string{title}
		main, extra, _ := strings.Cut(desc, "\n")
		if main != "" {
			for _, l := range strings.Split(lipgloss.NewStyle().Width(textW).Render(main), "\n") {
				lines = append(lines, line.Render(l))
			}
		}
		if extra != "" {
			for _, l := range strings.Split(lipgloss.NewStyle().Width(textW).Render(strings.ReplaceAll(extra, "\n", " ")), "\n") {
				lines = append(lines, muted.Render(l))
			}
		}
		for k := range lines {
			if i == c.cursor && o.why == "" {
				lines[k] = bar + lines[k]
			} else {
				lines[k] = "  " + lines[k]
			}
		}
		rows = append(rows, strings.Join(lines, "\n"))
	}
	sep := "\n\n"
	if c.compact {
		sep = "\n"
	}
	out := strings.Join(rows, sep)
	if c.later != "" {
		out += "\n\n" + muted.Render("  More soon: "+c.later)
	}
	return out
}

// badge is a small gold tag.
func badge(s string) string { return accent.Render("★ " + s) }

// heading is a screen's title, and one short line saying what it's for.
func heading(title, sub string) string {
	out := bold.Render(title)
	if sub != "" {
		out += "\n" + muted.Render(sub)
	}
	return out + "\n\n"
}
