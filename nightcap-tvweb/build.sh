#!/bin/sh
# Assembles the Samsung and LG packages' contents in build/tizen and build/webos: the shared
# launcher (launcher/) plus each TV's own files (tizen/, webos/). Then package them with the TVs'
# own tools: Samsung's `tizen package`, LG's `ares-package`.
set -e
cd "$(dirname "$0")"
rm -rf build
for tv in tizen webos; do
  mkdir -p build/$tv
  cp -R launcher/. build/$tv/
  cp -R $tv/. build/$tv/
done
# (Samsung's TV APIs load from $WEBAPIS on the TV; LG has no such file.)
sed -i.bak '/\$WEBAPIS/d' build/webos/index.html && rm build/webos/index.html.bak
# Samsung's launcher.js minified as LG's packaging minifies it (terser, its default settings), so
# both TVs get the same file; LG's is left as it is for ares-package.
npx -y terser@5.48.0 build/tizen/launcher.js --compress --mangle -o build/tizen/launcher.js
echo "Ready: build/tizen and build/webos"
