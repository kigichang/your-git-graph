#!/bin/bash
# Build "Your Git Graph.app": the clean-room check, the front end, the remote helpers, the
# third-party notices, the bundle, its signature checked; optionally a dmg and an install into
# /Applications.
#
#   app/scripts/build-app.sh [--universal] [--dmg] [--install]
#
#   --universal  arm64 + x86_64 (needs: rustup target add aarch64-apple-darwin x86_64-apple-darwin)
#   --dmg        also build the disk image
#   --install    replace /Applications/Your Git Graph.app with the new build
#                (also removes an older install named "Git Graph.app")
#
# Prerequisites (once): git submodule update --init (the engine, vendor/.../native); in app/
# `npm ci`. For the helpers of repositories over ssh (scripts/build-remote.sh):
# rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl, and
# brew install filosottile/musl-cross/musl-cross.
#
# Signing. Without anything set the app is ad-hoc signed (tauri.conf.json, signingIdentity "-"):
# fine on your own Mac; on another one it needs `xattr -dr com.apple.quarantine`. For a build
# others can open, set, in the environment:
#   APPLE_SIGNING_IDENTITY  the name of a code signing certificate in your keychain, for example
#                           "Developer ID Application: Your Name (TEAMID)" - or a self-signed one
#                           just to keep the signature stable between builds
#   APPLE_ID, APPLE_PASSWORD (an app-specific password), APPLE_TEAM_ID
#                           with a Developer ID certificate: the bundle is notarized and stapled
#                           (cargo tauri build does it when these are set); or
#   APPLE_API_ISSUER, APPLE_API_KEY, APPLE_API_KEY_PATH
#                           the same through an App Store Connect API key
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

echo "==> clean room"
"$app_dir/scripts/check-cleanroom.sh"

echo "==> front end"
(cd "$app_dir" && npm run build)

echo "==> remote helpers (repositories over ssh)"
"$app_dir/scripts/build-remote.sh"

echo "==> third-party notices"
(cd "$app_dir" && npm run --silent third-party)
if ! git -C "$app_dir" diff --quiet -- ../THIRD-PARTY.md; then
	echo "THIRD-PARTY.md changed with the dependencies: commit it" >&2
fi

echo "==> build ($bundles${target_args:+, universal})"
(cd "$tauri_dir" && cargo tauri build --bundles "$bundles" ${target_args[@]+"${target_args[@]}"})

bundle="$out/macos/Your Git Graph.app"
echo "==> check $bundle"
codesign --verify --deep --strict "$bundle"
identifier="$(codesign -dv "$bundle" 2>&1 | sed -n 's/^Identifier=//p')"
[ "$identifier" = dev.kigi.gitgraph ] || { echo "unexpected signing identifier: $identifier" >&2; exit 1; }
archs="$(lipo -archs "$bundle/Contents/MacOS/git-graph-app")"
[ -f "$bundle/Contents/Resources/THIRD-PARTY.md" ] || { echo "THIRD-PARTY.md is not in the bundle" >&2; exit 1; }
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
