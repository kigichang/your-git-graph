#!/bin/bash
# Build the helper the app copies to a remote machine (crates/remote), for every platform the app
# supports, into src-tauri/remote-dist/ (embedded by the next `cargo build` of the app):
#   <platform>.gz   the helper, gzipped
#   <platform>.id   "<first 16 hex of its sha256> <its size>": the name it gets over there
#
#   app/scripts/build-remote.sh [--native]
#
#   --native  only the helper for this Mac (darwin-arm64); the Linux ones stay as they are
#
# Needs (once): rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl, and the
# musl cross linkers (brew install filosottile/musl-cross/musl-cross). The helper is linked
# statically, so it runs on any Linux of that architecture.
set -euo pipefail

tauri_dir="$(cd "$(dirname "$0")/../src-tauri" && pwd)"
dist="$tauri_dir/remote-dist"
mkdir -p "$dist"

pack() { # <platform> <binary>
	gzip -9 -n -c "$2" > "$dist/$1.gz"
	echo "$(shasum -a 256 "$2" | cut -c1-16) $(wc -c < "$2" | tr -d ' ')" > "$dist/$1.id"
	echo "$1: $(cat "$dist/$1.id"), $(du -h "$dist/$1.gz" | cut -f1) gzipped"
}

cd "$tauri_dir"
[ "$(uname -sm)" = "Darwin arm64" ] || { echo "the native helper is expected to be darwin-arm64" >&2; exit 1; }
cargo build --release -p gg-remote
pack darwin-arm64 target/release/gg-remote
[ "${1:-}" = --native ] && exit 0

installed="$(rustup target list --installed)"
for pair in linux-x86_64:x86_64-unknown-linux-musl:x86_64-linux-musl-gcc linux-aarch64:aarch64-unknown-linux-musl:aarch64-linux-musl-gcc; do
	IFS=: read -r platform target linker <<<"$pair"
	grep -qx "$target" <<<"$installed" || { echo "missing Rust target: rustup target add $target" >&2; exit 1; }
	command -v "$linker" >/dev/null || { echo "missing linker $linker: brew install filosottile/musl-cross/musl-cross" >&2; exit 1; }
	variable="CARGO_TARGET_$(tr 'a-z-' 'A-Z_' <<<"$target")_LINKER"
	env "$variable=$linker" cargo build --release -p gg-remote --target "$target"
	pack "$platform" "target/$target/release/gg-remote"
done
