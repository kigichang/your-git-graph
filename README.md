# Your Git Graph

A git graph app for macOS: the commit graph of a repository, the details of each commit, and the
everyday operations (branches, tags, remotes, stashes, merges, rebases, cherry-picks, resets)
from context menus - for repositories on this Mac, on a network share, or on another machine
over ssh. Built with [Tauri 2](https://tauri.app): a Svelte front end, a Rust host, and the
[git-graph-core](https://github.com/neophack/vscode-git-graph-rs) engine (`native/core` of that
repository, MIT, a git submodule) for reading; writes run the `git` CLI.

> **Licence.** The source code in this repository is MIT ([LICENSE](LICENSE)); what the app
> bundles besides is listed in [THIRD-PARTY.md](THIRD-PARTY.md). The app contains nothing of
> mhutchie's Git Graph or of the vscode-git-graph-rs extension's own code - only its engine,
> which is MIT. (The first version of this app, on the `main` branch, embedded that extension's
> webview and could not be distributed; this version, `stage-2`, is a clean-room rewrite of
> everything but the engine.)
>
> This is an independent project, not affiliated with or endorsed by mhutchie's
> [Git Graph](https://github.com/mhutchie/vscode-git-graph) or
> [vscode-git-graph-rs](https://github.com/neophack/vscode-git-graph-rs); "Git Graph" only
> describes what it shows.

## Build

Needs Xcode's command line tools, Rust (1.82+), Node (22+) and `cargo install tauri-cli --version '^2'`.

```sh
git clone --recursive https://github.com/kigichang/your-git-graph   # or: git submodule update --init
(cd app && npm ci)
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl   # the helpers for repositories over ssh
brew install filosottile/musl-cross/musl-cross                           # their linkers
app/scripts/build-app.sh --install  # → /Applications/Your Git Graph.app (add --dmg, --universal)
```

A build with nothing else set is ad-hoc signed, for your own Mac: copied to another Mac, the app
needs `xattr -dr com.apple.quarantine "/Applications/Your Git Graph.app"` first. The script's
header says which environment variables sign it with a Developer ID certificate and notarize it.
Development: `(cd app && npm run build && cd src-tauri && cargo build --workspace)`, or
`cargo tauri dev --config tauri.dev.conf.json` in `app/src-tauri` for a window on Vite's dev
server; `app/CLAUDE.md`'s parent, [CLAUDE.md](CLAUDE.md), describes the code and its checks.

## Use

Launch the app and add a repository (＋ in the sidebar, File > Open Repository… ⌘O, a folder
dropped on the window or the Dock icon, `open -a "Your Git Graph" /path/to/repo`), or a folder
holding several: each repository in it is added. Without arguments the app reopens the
repository shown last, or the start page with the recent ones.

- **The graph.** Click a row for the commit's details and files; click a file for its change
  in a diff window (Monaco), ⌘-click for the file itself at that commit, ⇧-click two rows to
  compare them. Markdown files show a rendered preview beside the source (tables, code, maths,
  images of the repository, Mermaid; PlantUML through a `plantuml.jar` named in the settings).
  The toolbar filters by branch and author, shows or hides remote branches, follows the first
  parent only, fetches, refreshes, finds (⌘F: subject, author, hash, labels; case and regex
  switches), and opens the reflog, the worktrees and the settings. ⌘J goes to HEAD. The graph
  follows changes made elsewhere (a commit in a terminal, an edit in an editor) by itself.
- **Operations.** Right-click a row, a branch or tag label, a stash, the uncommitted row or the
  empty space for what applies: create, check out, rename, delete, merge, rebase (interactive
  ones open in Terminal), cherry-pick, revert, reset, drop, edit a message, fixup, squash, tags
  (and pushing them), stashes, pull, push, fetch, prune, clean, archives, worktrees. Before an
  operation that would lose commits or changes the app says what and asks; long ones (fetch,
  pull, push) show git's output and can be cancelled. git's questions (passwords, passphrases,
  host keys) appear in the app.
- **The sidebar** lists the repositories added, with how far each is ahead of or behind its
  upstream; right-click for Reveal in Finder, Open in Terminal, Open in New Window, Remove.
  Drag to reorder, or into a group (＋ > New Group…; ⌘-click or ⇧-click selects several).
  ⌃⌘S hides it; File > New Window (⌘N) opens another window on the same list.
- **Settings** (⌘,): the language (English, Traditional Chinese), the date format, the graph's
  look, how many commits load, the order, what to show, the author identity (synced with
  git's global config), the shown repository's remotes and user details, the defaults of the
  dialogs. Each repository remembers its filters; Export Repository Config writes them to
  `<repo>/.your-git-graph.json` for a clone elsewhere to pick up. View > Appearance picks
  light or dark.

**Repositories on other machines.** ＋ (or the File menu) also offers:

- *Add SSH Repository…*: a host (`user@host`, or a `Host` of `~/.ssh/config`) and a folder
  there. Nothing is mounted: as VS Code's Remote-SSH does, the app copies a small helper (the
  engine and a git runner, to `~/.cache/your-git-graph/` on that machine) and talks to it over
  one `ssh` connection; git runs there. Linux (x86_64, arm64) and macOS (arm64) machines, with
  git and gzip installed. ssh's questions and those of the git over there appear in the app.
  Commits, checkouts and fetches made there show by themselves; edits of the work tree when the
  window comes back to the front. Not for such repositories: Reveal in Finder, opening a file,
  archives.
- *Connect to Server (SMB)…*: mounts a share (`smb://server/share`; macOS asks for the name and
  password) and lets you pick a repository on it. A repository on a share is an ordinary folder
  to the app, which remembers the share's address.

A repository whose machine is not connected, or whose share is not mounted, is faded in the
sidebar: click it to connect or mount again. Only the repository shown last is reconnected at
launch.

Requirements: macOS 13 or later; git (Xcode's command line tools or Homebrew's). Settings and
state live in `~/Library/Application Support/dev.kigi.gitgraph/` (`settings.json`, `state.json`).
