#!/bin/bash
# Build "Your Git Graph.app" for personal use: ad-hoc signed (no Apple Developer account, no
# notarization), checked, and optionally a dmg and an install into /Applications.
#
#   app/scripts/build-app.sh [--universal] [--dmg] [--install]
#
#   --universal  arm64 + x86_64 (needs: rustup target add aarch64-apple-darwin x86_64-apple-darwin)
#   --dmg        also build the disk image
#   --install    replace /Applications/Your Git Graph.app with the new build
#                (also removes an older install named "Git Graph.app")
#
# Prerequisites (once): git submodule update --init; in vendor/vscode-git-graph-rs
# `npm ci && npm run compile-src && npm run compile-web`; in app/ `npm ci`.
#
# APPLE_SIGNING_IDENTITY=<name of a code signing certificate in your keychain> signs with that
# certificate instead of ad hoc (see CLAUDE.md, Stage 1 item 8).
set -euo pipefail

universal=0; dmg=0; install=0
for arg in "$@"; do
	case "$arg" in
		--universal) universal=1 ;;
		--dmg) dmg=1 ;;
		--install) install=1 ;;
		*) echo "unknown option $arg" >&2; sed -n '2,15p' "$0" >&2; exit 2 ;;
	esac
done

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
tauri_dir="$app_dir/src-tauri"
[ -d "$app_dir/node_modules/monaco-editor" ] || { echo "run 'npm ci' in $app_dir first" >&2; exit 1; }
command -v cargo-tauri >/dev/null || cargo tauri --version >/dev/null 2>&1 || { echo "tauri-cli missing: cargo install tauri-cli --version '^2'" >&2; exit 1; }

target_args=(); out="$tauri_dir/target/release/bundle"
if [ "$universal" = 1 ]; then
	installed="$(rustup target list --installed)"
	for t in aarch64-apple-darwin x86_64-apple-darwin; do
		grep -qx "$t" <<<"$installed" || { echo "missing Rust target $t: rustup target add $t" >&2; exit 1; }
	done
	target_args=(--target universal-apple-darwin)
	out="$tauri_dir/target/universal-apple-darwin/release/bundle"
fi
bundles=app; [ "$dmg" = 1 ] && bundles=app,dmg

echo "==> assets"
node "$app_dir/scripts/prepare-ui.mjs"

echo "==> build ($bundles${target_args:+, universal})"
(cd "$tauri_dir" && cargo tauri build --bundles "$bundles" ${target_args[@]+"${target_args[@]}"})

bundle="$out/macos/Your Git Graph.app"
echo "==> check $bundle"
codesign --verify --deep --strict "$bundle"
identifier="$(codesign -dv "$bundle" 2>&1 | sed -n 's/^Identifier=//p')"
[ "$identifier" = dev.kigi.gitgraph ] || { echo "unexpected signing identifier: $identifier" >&2; exit 1; }
archs="$(lipo -archs "$bundle/Contents/MacOS/git-graph-app")"
echo "signed ($(codesign -dv "$bundle" 2>&1 | sed -n 's/^Signature=//p')), $archs, $(du -sh "$bundle" | cut -f1)"
[ "$dmg" = 1 ] && ls -1 "$out"/dmg/*.dmg

if [ "$install" = 1 ]; then
	dest="/Applications/Your Git Graph.app"
	legacy="/Applications/Git Graph.app"  # the old name of this app (same bundle identifier)
	ours() { [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null || true)" = dev.kigi.gitgraph ]; }
	running() { pgrep -f "$1/Contents/MacOS/" >/dev/null; }
	if [ -e "$dest" ]; then
		ours "$dest" || { echo "$dest is not this app: not replaced" >&2; exit 1; }
		running "$dest" && { echo "the app is running from $dest: quit it first" >&2; exit 1; }
	fi
	if [ -e "$legacy" ] && ours "$legacy"; then
		running "$legacy" && { echo "the app is running from $legacy: quit it first" >&2; exit 1; }
	else
		legacy=""
	fi
	rm -rf "$dest"
	ditto "$bundle" "$dest"
	echo "installed $dest"
	if [ -n "$legacy" ]; then rm -rf "$legacy"; echo "removed $legacy"; fi
fi
