#!/bin/bash
# Stage 2 is a clean-room rewrite: nothing in app/ may come from the upstream webview or
# extension host (vendor/vscode-git-graph-rs/web and src, whose licence forbids distributing
# derived work). This fails when a trace of them shows up in the sources, or when a build still
# copies their output. Run before every commit; npm test and build-app.sh run it too.
#
#   app/scripts/check-cleanroom.sh
set -u
app_dir="$(cd "$(dirname "$0")/.." && pwd)"
status=0

# Names that only the upstream code uses: its webview bridge, its CSS token prefix, its bundle,
# its setting prefix and the configuration file it writes (the submodule's own name is fine).
patterns='acquireVsCodeApi|--vscode-|out\.min\.(js|css)|vscode-git-graph\.json|git-graph-rs\.|vscode-(light|dark|high-contrast)'
hits="$(grep -rnE "$patterns" "$app_dir" \
	--include='*.ts' --include='*.js' --include='*.mjs' --include='*.svelte' --include='*.html' --include='*.css' --include='*.rs' --include='*.json' --include='*.sh' --include='*.md' \
	--exclude-dir=node_modules --exclude-dir=target --exclude-dir=dist --exclude-dir=diff-dist --exclude-dir=gen --exclude-dir=remote-dist \
	--exclude=check-cleanroom.sh --exclude=package-lock.json)"
if [ -n "$hits" ]; then
	echo "upstream names in app/ (see CLAUDE.md, clean room):" >&2
	echo "$hits" >&2
	status=1
fi

# Directories a Stage 1 build used to fill from upstream.
for gone in ui/media ui/generated ui scripts/prepare-ui.mjs scripts/zh-tw.mjs; do
	if [ -e "$app_dir/$gone" ]; then
		echo "$app_dir/$gone exists: a Stage 1 leftover" >&2
		status=1
	fi
done

[ "$status" = 0 ] && echo "clean room: ok"
exit "$status"
