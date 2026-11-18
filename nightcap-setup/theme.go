package main

import "github.com/charmbracelet/lipgloss"

// Nightcap's colours in the terminal: its gold accent, and text that reads on a dark or a light
// terminal (the terminal's own background is kept).
var (
	gold  = lipgloss.AdaptiveColor{Light: "#9A6200", Dark: "#F6B73C"} // (a deeper gold reads on white)
	green = lipgloss.AdaptiveColor{Light: "#1F8A4C", Dark: "#5BD38A"}
	red   = lipgloss.AdaptiveColor{Light: "#C23B3B", Dark: "#FF7A7A"}
	dim   = lipgloss.AdaptiveColor{Light: "#6B7385", Dark: "#8D97AB"}
	faint = lipgloss.AdaptiveColor{Light: "#C3C8D3", Dark: "#3A4254"}
)

var (
	// (Plain and bold text are the terminal's own colour: readable on any background, even where
	// the terminal can't say whether it's dark, like Windows or tmux.)
	bold      = lipgloss.NewStyle().Bold(true)
	plain     = lipgloss.NewStyle()
	muted     = lipgloss.NewStyle().Foreground(dim)
	accent    = lipgloss.NewStyle().Foreground(gold)
	accentB   = lipgloss.NewStyle().Foreground(gold).Bold(true)
	good      = lipgloss.NewStyle().Foreground(green)
	bad       = lipgloss.NewStyle().Foreground(red)
	frameLine = lipgloss.NewStyle().Foreground(faint)
)
