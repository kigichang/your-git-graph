# Your Git Graph

A macOS app (Tauri 2) that shows a git repository as a graph of its commits and lets you work
with it: branches, tags, remotes, stashes, merges, rebases, diffs. Reads come from the Rust engine
`git-graph-core` of [vscode-git-graph-rs](https://github.com/neophack/vscode-git-graph-rs)
(submodule in `vendor/`, MIT), linked in-process; writes run the `git` CLI.

> **This branch (`stage-2`) is a rewrite in progress.** The first version of the app ran the
> upstream webview, whose license forbids distributing derived work, so it could only be built
> for one's own use. Stage 2 replaces everything that came from upstream's `web/` and `src/`
> with the app's own front end (Svelte) and host (Rust), written clean-room from the behaviour
> spec in `app/docs/spec/`; only the MIT engine stays. Until it is done, the app on this branch
> shows little. The usable Stage 1 app is on `main`.
>
> **License:** the source code in this repository is MIT ([LICENSE](LICENSE)). This is an
> independent project, not affiliated with or endorsed by mhutchie's
> [Git Graph](https://github.com/mhutchie/vscode-git-graph) or
> [vscode-git-graph-rs](https://github.com/neophack/vscode-git-graph-rs); "Git Graph" only
> describes what it shows.

## Build

```sh
git clone --recursive https://github.com/kigichang/your-git-graph   # or: git submodule update --init
(cd app && npm ci)                 # Vite, Svelte, Monaco, esbuild
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl   # the helper for repositories over ssh
brew install filosottile/musl-cross/musl-cross                           # its linkers
app/scripts/build-app.sh --install  # → /Applications/Your Git Graph.app (add --dmg, --universal)
```

For development: `cd app && npm run build && (cd src-tauri && cargo build --workspace)` gives
`app/src-tauri/target/debug/git-graph-app`, which embeds the built front end; `cargo tauri dev
--config tauri.dev.conf.json` (in `app/src-tauri`) runs it against Vite's dev server instead.

Builds are ad-hoc signed for use on your own Mac (no Apple Developer account, no notarization).
Copied to another Mac, the app needs `xattr -dr com.apple.quarantine "/Applications/Your Git Graph.app"` first.

## Tests

```sh
cd app && npm test                           # clean-room check, then the front end's unit tests (vitest)
cd app && npm run check                      # svelte-check
cd app/src-tauri && cargo test --workspace   # Rust: the app, the shared backend, the remote helper
app/scripts/selftest.sh app/src-tauri/target/debug/git-graph-app <scratch repository>   # end to end
```

## Credits

- [vscode-git-graph-rs](https://github.com/neophack/vscode-git-graph-rs) by penghongxia: the Rust
  engine (`git-graph-core`, MIT) that reads the repositories.
- [Tauri](https://tauri.app), [Svelte](https://svelte.dev) and
  [Monaco Editor](https://microsoft.github.io/monaco-editor/).
