#!/bin/bash
# Screenshot the app in a given state (GG_PREVIEW, see host/main.js runPreview), to look at the
# theme. Needs Screen Recording permission for the terminal. Never touches your settings: the
# app runs on a temporary GG_DATA_DIR.
#
#   app/scripts/preview.sh <app binary> <repo> <scenes> <light|dark|system> <out prefix>
#
#   scenes: comma-separated, in order: details (open a commit), settings, menu (context menu),
#           dialog (Create Branch), find, diff (opens a diff window); add "contrast" to force
#           Increase Contrast. One PNG per window: <out prefix>-0.png, -1.png, ...
set -euo pipefail
app="$1"; repo="$2"; scenes="$3"; appearance="$4"; out="$5"

helper="${TMPDIR:-/tmp}/gg-window-ids"
if [ ! -x "$helper" ]; then
	cat > "$helper.swift" <<'SWIFT'
import CoreGraphics
// The on-screen windows of a process: "<window id>" per line.
let pid = Int(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerPID as String] as? Int) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
    print(w[kCGWindowNumber as String]!)
}
SWIFT
	swiftc -O -o "$helper" "$helper.swift"
fi

data="$(mktemp -d -t gg-preview)"
log="$data/log"
[ "$appearance" != system ] && printf '{"appearance":"%s","migratedFromLocalStorage":true}' "$appearance" > "$data/state.json"
GG_DATA_DIR="$data" GG_PREVIEW="$scenes" "$app" "$repo" > "$log" 2>&1 &
pid=$!
for _ in $(seq 1 60); do grep -q "preview: " "$log" && break; sleep 0.5; done
sleep 1.5 # let the last scene settle (menus fade in, diff windows render)
i=0
for id in $("$helper" "$pid"); do
	screencapture -x -o -l "$id" "$out-$i.png"
	echo "$out-$i.png"
	i=$((i + 1))
done
kill "$pid" 2>/dev/null || true
grep "preview: " "$log" || { echo "no preview report:" >&2; cat "$log" >&2; }
rm -rf "$data"
