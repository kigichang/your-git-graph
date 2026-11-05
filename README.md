# Your Git Graph

A Tauri 2 shell around [vscode-git-graph-rs](https://github.com/neophack/vscode-git-graph-rs)
(submodule in `vendor/`). The upstream webview runs unchanged; `app/ui/host/` stands in for the
VS Code extension host: reads come from the Rust engine (`git-graph-core`, linked in-process),
writes run the `git` CLI.

> **License:** the source code in this repository is MIT ([LICENSE](LICENSE)). **Builds are for
> your own use only and must not be distributed:** a build bundles the upstream webview
> (`vendor/.../web`, `src`), which derives from mhutchie's Git Graph, whose license forbids
> distributing derivative works. That is why there are no binary releases - build it yourself.
> The upstream engine (`native/`) is MIT.
>
> This is an independent project, not affiliated with or endorsed by mhutchie's
> [Git Graph](https://github.com/mhutchie/vscode-git-graph) or
> [vscode-git-graph-rs](https://github.com/neophack/vscode-git-graph-rs); "Git Graph" only
> describes what it shows.

## Build

```sh
git clone --recursive https://github.com/kigichang/your-git-graph   # or: git submodule update --init
(cd vendor/vscode-git-graph-rs && npm ci && npm run compile-src && npm run compile-web)
(cd app && npm ci)                 # Monaco + esbuild for the diff window
node app/scripts/prepare-ui.mjs
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl   # the helper for repositories over ssh
brew install filosottile/musl-cross/musl-cross                           # its linkers
app/scripts/build-app.sh --install  # → /Applications/Your Git Graph.app (add --dmg, --universal)
```

Builds are ad-hoc signed for use on your own Mac (no Apple Developer account, no notarization).
Copied to another Mac, the app needs `xattr -dr com.apple.quarantine "/Applications/Your Git Graph.app"` first.

Run against a repository, or a folder holding several: `"Your Git Graph.app/Contents/MacOS/git-graph-app" /path/to/repo`
(or launch without arguments: it reopens the repository shown last, or the start page).
The sidebar on the left lists the repositories added to the app (＋, File > Open Repository… ⌘O,
Open Recent) with how far each is ahead of / behind its upstream; click one to show it, right-click
for Reveal in Finder, Open in Terminal, Open in New Window and Remove. Drag a repository to reorder it, or into a group: ＋ > New Group… makes one (right-click
its name to rename or delete it, drag it to reorder the groups, click it to fold the group away); repositories in no group are listed under "default". Toggle the
sidebar with the button at its top or ⌃⌘S. File > New Window (⌘N) opens another window on the same list. The graph
follows changes made elsewhere (a commit in a terminal, an edit in an editor) by itself.

**Repositories on other machines.** ＋ (or the File menu) also offers:

- *Add SSH Repository…*: a host (`user@host`, or a `Host` of `~/.ssh/config`) and a folder there.
  Nothing is mounted: as VS Code's Remote-SSH does, the app copies a small helper (the engine and
  a git runner, `~/.cache/your-git-graph/` on that machine) and talks to it over one `ssh`
  connection; git runs there. Linux (x86_64, arm64) and macOS (arm64) machines, with git and gzip
  installed. ssh's questions (password, passphrase, host key) and those of the git over there
  appear in the app. Commits, checkouts and fetches made there show by themselves; edits of the
  work tree when the window comes back to the front. Not for such repositories: Reveal in Finder,
  opening a file, the external directory diff, archives.
- *Connect to Server (SMB)…*: mounts a share (`smb://server/share`; macOS asks for the name and
  password) and lets you pick a repository on it. A repository on a share is an ordinary folder
  to the app, which remembers the share's address.

A repository whose machine is not connected, or whose share is not mounted, is faded in the
sidebar: click it to connect or mount again. Only the repository shown last is reconnected at
launch.

`app/scripts/selftest.sh <binary> <repo or folder>` runs the built-in end-to-end self-test (it
writes temporary branches/files into the repository: use a scratch clone).

## Tests

```sh
cd app && npm test                 # host git operations against real git (temp repos), diff specs
cd app/src-tauri && cargo test --workspace   # Rust: the app, the shared backend, the remote helper
```

## Scope

Every request of the webview protocol has a handler. Diffs open in their own window (Monaco):
text side by side or inline, a file at a revision, a whole comparison with its file list, images
side by side; Esc closes a diff window. Credential prompts from git (HTTPS) and
ssh (passphrases, host keys) appear in the app's window; the macOS keychain is used as usual.
Settings changed in the view's Settings panel apply to every window at once and are kept in
`~/Library/Application Support/dev.kigi.gitgraph/settings.json`, which can also be edited by
hand (Settings > Open Extension Settings opens it); the view state (pinned commits, column
widths, …) is kept next to it in `state.json`. Settings… (⌘,) is in the app menu; View has
Refresh (⌘R), Find (⌘F), Show HEAD Commit (⌘J), Fetch (⌘⇧F) and Appearance (System, Light,
Dark). The theme follows the system's light / dark appearance, accent colour and Increase
Contrast.
The interface is in English or Traditional Chinese (Taiwan), converted at build time from
upstream's Chinese strings.
Not offered yet: avatars, pull requests, Gerrit, tracking remote tags - see the roadmap in
`CLAUDE.md`.

## Credits

- [vscode-git-graph-rs](https://github.com/neophack/vscode-git-graph-rs) by penghongxia: the Rust
  engine (`git-graph-core`, MIT) that reads the repositories, and the webview the app runs.
- [Git Graph](https://github.com/mhutchie/vscode-git-graph) by mhutchie, which that webview is
  ported from.
- [Tauri](https://tauri.app) and [Monaco Editor](https://microsoft.github.io/monaco-editor/).
