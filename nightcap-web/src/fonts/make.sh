#!/bin/sh
# The web app's fonts as WOFF2 subsets, made from the TV's full TTFs in public/fonts (which the TVs
# keep using). Latin and Latin Extended, the same ranges as Google Fonts' (with → and ▶, which the
# app uses); a page only fetches the second when it shows one of its letters.
# Needs fonttools and brotli: pip install fonttools brotli
set -e
cd "$(dirname "$0")"
LATIN="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191-2193,U+2212,U+2215,U+25B6,U+FEFF,U+FFFD"
EXT="U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"
for f in hanken big_shoulders; do
  pyftsubset "../../public/fonts/$f.ttf" --unicodes="$LATIN" --layout-features='*' --flavor=woff2 --output-file="$f-latin.woff2"
  pyftsubset "../../public/fonts/$f.ttf" --unicodes="$EXT" --layout-features='*' --flavor=woff2 --output-file="$f-latin-ext.woff2"
done
