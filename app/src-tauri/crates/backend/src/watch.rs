//! Watching repositories, so a commit, checkout or edit made elsewhere (a terminal, an editor)
//! shows up in the graph by itself.
//!
//! FSEvents (through `notify`) reports every file change under the watched roots; changes are
//! gathered for a short quiet period, then [`classify`] decides which repositories they matter
//! to: inside `.git` only HEAD, refs, the index and the in-progress-operation markers count
//! (objects, logs and lock files are noise); in the working tree a change counts unless every
//! changed path is ignored by .gitignore (a build writing into `target/` refreshes nothing).
//!
//! A linked worktree's (or a submodule's) `.git` is a file pointing at its git directory
//! elsewhere (`main/.git/worktrees/<name>`), which shares refs with the main repository's
//! (`commondir`). Both are watched too; HEAD, the index and the operation markers in its own git
//! directory count for that worktree only, the shared refs for every repository using them.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{EventKind, RecursiveMode, Watcher};

/// How long changes are gathered before deciding: a checkout touches many files at once.
const QUIET: Duration = Duration::from_millis(300);

/// Does a change at `inner` (relative to `.git`) change what the graph shows?
fn relevant_git_path(inner: &Path) -> bool {
    let parts: Vec<&str> = inner.components().filter_map(|c| match c {
        Component::Normal(s) => s.to_str(),
        _ => None,
    }).collect();
    let (Some(first), Some(last)) = (parts.first(), parts.last()) else { return false };
    if last.ends_with(".lock") {
        return false;
    }
    match *first {
        "refs" | "rebase-merge" | "rebase-apply" => true,
        "HEAD" | "ORIG_HEAD" | "FETCH_HEAD" | "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "packed-refs" | "index" | "config" => parts.len() == 1,
        _ => false, // objects, logs, hooks, COMMIT_EDITMSG, ...
    }
}

/// Does a change at `inner` (relative to a common git directory another worktree shares)
/// change that worktree's graph? Only the refs are shared; HEAD, the index and the operation
/// markers there are the main worktree's own.
fn relevant_shared_path(inner: &Path) -> bool {
    relevant_git_path(inner) && matches!(inner.components().next(), Some(Component::Normal(s)) if s == "refs" || s == "packed-refs" || s == "config")
}

/// A watched repository: its work tree, its git directory, and the git directory it shares
/// refs with (the same one except for a linked worktree).
#[derive(Debug, Clone)]
pub struct Repo {
    root: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
}

impl Repo {
    pub fn of(root: PathBuf) -> Repo {
        let canonical = |p: PathBuf| p.canonicalize().unwrap_or(p);
        let root = canonical(root);
        let git_dir = canonical(crate::repo::git_dir(&root).unwrap_or_else(|| root.join(".git")));
        let common_dir = std::fs::read_to_string(git_dir.join("commondir"))
            .map(|text| canonical(git_dir.join(text.trim())))
            .unwrap_or_else(|_| git_dir.clone());
        Repo { root, git_dir, common_dir }
    }
}

/// Whether any of the working-tree `paths` (relative to `root`) is not ignored by .gitignore.
/// Without git, or on any failure to ask it, every path counts: a needless refresh beats a
/// missed one.
fn not_ignored(git: Option<&Path>, root: &Path, paths: &[PathBuf]) -> bool {
    let Some(git) = git else { return true };
    let run = || -> Option<bool> {
        let mut child = Command::new(git)
            .args(["check-ignore", "--stdin", "-z"])
            .current_dir(root)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .envs(crate::git::config_overrides())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let mut input = Vec::new();
        for p in paths {
            input.extend_from_slice(p.as_os_str().as_encoded_bytes());
            input.push(0);
        }
        child.stdin.take()?.write_all(&input).ok()?;
        let output = child.wait_with_output().ok()?;
        // exit 0: some are ignored (listed), 1: none is, anything else: cannot tell
        match output.status.code() {
            Some(1) => Some(true),
            Some(0) => {
                let ignored: BTreeSet<&[u8]> = output.stdout.split(|&b| b == 0).filter(|s| !s.is_empty()).collect();
                Some(paths.iter().any(|p| !ignored.contains(p.as_os_str().as_encoded_bytes())))
            }
            _ => None,
        }
    };
    run().unwrap_or(true)
}

/// Which of `repos` (by their roots) the changed `paths` matter to. A path in a git directory
/// matters to the repositories using it; any other path belongs to the deepest root containing
/// it, so a nested repository's changes are its own.
pub fn classify(git: Option<&Path>, repos: &[Repo], paths: &[PathBuf]) -> BTreeSet<PathBuf> {
    let mut changed = BTreeSet::new();
    let mut worktree: BTreeMap<&PathBuf, Vec<PathBuf>> = BTreeMap::new();
    for path in paths {
        let mut in_git_dir = false;
        for repo in repos {
            if let Ok(inner) = path.strip_prefix(&repo.git_dir) {
                in_git_dir = true;
                if relevant_git_path(inner) {
                    changed.insert(repo.root.clone());
                }
            } else if let Ok(inner) = path.strip_prefix(&repo.common_dir) {
                in_git_dir = true;
                if relevant_shared_path(inner) {
                    changed.insert(repo.root.clone());
                }
            }
        }
        if in_git_dir {
            continue;
        }
        let Some(root) = repos.iter().map(|r| &r.root).filter(|r| path.starts_with(r)).max_by_key(|r| r.as_os_str().len()) else { continue };
        let relative = path.strip_prefix(root).unwrap_or(path);
        // The root itself, or a linked worktree's `.git` file.
        if relative.as_os_str().is_empty() || relative.starts_with(".git") {
            continue;
        }
        worktree.entry(root).or_default().push(relative.to_path_buf());
    }
    for (root, rels) in worktree {
        if !changed.contains(root) && not_ignored(git, root, &rels) {
            changed.insert(root.clone());
        }
    }
    changed
}

/// What turns the repositories [`watch`] reports (their real paths) back into the names `roots`
/// gave them: whoever asked compares its own strings, and a path through a symlink is not the
/// real one. Two names for one repository both answer.
pub fn named(roots: &[String]) -> impl Fn(&BTreeSet<PathBuf>) -> Vec<String> + Send + 'static {
    let asked: Vec<(PathBuf, String)> = roots.iter().map(|root| (Path::new(root).canonicalize().unwrap_or_else(|_| PathBuf::from(root)), root.clone())).collect();
    move |changed| asked.iter().filter(|(real, _)| changed.contains(real)).map(|(_, name)| name.clone()).collect()
}

/// Watch `roots` and call `on_change` with the repositories a burst of changes matters to.
/// Without `worktrees` only their git directories are watched (commits, checkouts, staging,
/// fetches): inotify, unlike FSEvents, takes one watch per directory, and a work tree with
/// `node_modules` runs into the system's limit.
/// Dropping the returned watcher stops it (and its thread).
pub fn watch(
    git: Option<PathBuf>,
    roots: Vec<PathBuf>,
    worktrees: bool,
    on_change: impl Fn(BTreeSet<PathBuf>) + Send + 'static,
) -> notify::Result<notify::RecommendedWatcher> {
    let repos: Vec<Repo> = roots.into_iter().map(Repo::of).collect();
    // The roots, and the git directories outside them (linked worktrees, submodules); nothing
    // twice (FSEvents watches recursively).
    let mut dirs: Vec<PathBuf> = if worktrees { repos.iter().map(|r| r.root.clone()).collect() } else { Vec::new() };
    dirs.extend(repos.iter().flat_map(|r| [r.git_dir.clone(), r.common_dir.clone()]).filter(|d| d.is_dir()));
    dirs.sort();
    let mut watched: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        if !watched.iter().any(|w| dir.starts_with(w)) {
            watched.push(dir);
        }
    }
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        if let Ok(event) = result {
            if !matches!(event.kind, EventKind::Access(_)) {
                for path in event.paths {
                    let _ = tx.send(path);
                }
            }
        }
    })?;
    // A root that cannot be watched (an unmounted volume) must not cost the others theirs.
    for dir in &watched {
        if let Err(e) = watcher.watch(dir, RecursiveMode::Recursive) {
            eprintln!("[watch] not watching {}: {e}", dir.display());
        }
    }
    std::thread::spawn(move || {
        // Ends when the watcher (and with it the sender) is dropped.
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            let deadline = Instant::now() + QUIET;
            while let Ok(path) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                batch.push(path);
            }
            let changed = classify(git.as_deref(), &repos, &batch);
            if !changed.is_empty() {
                on_change(changed);
            }
        }
    });
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn git_path() -> PathBuf {
        PathBuf::from(&crate::git::locate_git().unwrap().path)
    }
    fn git() -> Option<&'static Path> {
        static GIT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        Some(GIT.get_or_init(git_path).as_path())
    }

    fn repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        assert!(Command::new(git_path()).args(["init", "-q"]).current_dir(&root).status().unwrap().success());
        std::fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        (dir, root)
    }

    #[test]
    fn changes_are_reported_by_the_names_asked_for() {
        let (dir, root) = repo();
        let link = dir.path().parent().unwrap().join(format!("gg-watch-link-{}", std::process::id()));
        std::os::unix::fs::symlink(&root, &link).unwrap();
        let other = root.join("not-changed").display().to_string();
        let (real, through_link) = (root.display().to_string(), link.display().to_string());
        let names = named(&[through_link.clone(), other, real.clone()]);
        let reported = names(&classify(git(), &[Repo::of(link.clone())], &[root.join(".git/HEAD")]));
        std::fs::remove_file(&link).unwrap();
        assert_eq!(reported, [through_link, real]);
    }

    /// A change in the working tree asks `git check-ignore`, unasked by anyone: a repository's
    /// own config must not get a program started that way.
    #[test]
    fn asking_what_is_ignored_does_not_run_the_fsmonitor_a_repository_names() {
        let (_d, root) = repo();
        let marker = root.join(".git/ran");
        let program = root.join(".git/monitor.sh");
        std::fs::write(&program, format!("#!/bin/sh\ntouch '{}'\nexit 1\n", marker.display())).unwrap();
        std::fs::set_permissions(&program, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        assert!(Command::new(git_path()).args(["config", "core.fsmonitor", program.to_str().unwrap()]).current_dir(&root).status().unwrap().success());
        assert!(not_ignored(git(), &root, &[PathBuf::from("a.txt")]));
        assert!(!marker.exists());
    }

    #[test]
    fn git_directory_noise_is_ignored_and_state_changes_count() {
        let (_d, root) = repo();
        let roots = vec![Repo::of(root.clone())];
        let at = |p: &str| vec![root.join(p)];
        for noise in [".git/objects/ab/cdef", ".git/logs/HEAD", ".git/index.lock", ".git/refs/heads/main.lock", ".git/COMMIT_EDITMSG", ".git/hooks/pre-commit"] {
            assert!(classify(git(), &roots, &at(noise)).is_empty(), "{noise}");
        }
        for signal in [".git/HEAD", ".git/refs/heads/main", ".git/refs/stash", ".git/packed-refs", ".git/index", ".git/MERGE_HEAD", ".git/rebase-merge/msgnum"] {
            assert_eq!(classify(git(), &roots, &at(signal)), BTreeSet::from([root.clone()]), "{signal}");
        }
    }

    #[test]
    fn ignored_working_tree_changes_do_not_count() {
        let (_d, root) = repo();
        let roots = vec![Repo::of(root.clone())];
        let ignored = vec![root.join("target/debug/app"), root.join("build.log")];
        assert!(classify(git(), &roots, &ignored).is_empty());
        let mixed = vec![root.join("target/x"), root.join("src/main.rs")];
        assert_eq!(classify(git(), &roots, &mixed), BTreeSet::from([root.clone()]));
        assert!(classify(git(), &roots, &[PathBuf::from("/elsewhere/file")]).is_empty());
        assert_eq!(classify(None, &roots, &ignored), BTreeSet::from([root.clone()]), "without git every change counts");
    }

    #[test]
    fn a_nested_repository_owns_its_changes() {
        let (_d, root) = repo();
        let nested = root.join("vendor/lib");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(Command::new(git_path()).args(["init", "-q"]).current_dir(&nested).status().unwrap().success());
        let roots = vec![Repo::of(root.clone()), Repo::of(nested.clone())];
        assert_eq!(classify(git(), &roots, &[nested.join(".git/HEAD")]), BTreeSet::from([nested.clone()]));
        assert_eq!(classify(git(), &roots, &[root.join("README")]), BTreeSet::from([root.clone()]));
    }

    /// A repository at `main` with one commit and a linked worktree at `wt` beside it.
    fn with_worktree() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let (main, wt) = (base.join("main"), base.join("wt"));
        std::fs::create_dir(&main).unwrap();
        let run = |cwd: &Path, args: &[&str]| assert!(Command::new(git_path()).args(args).current_dir(cwd).status().unwrap().success(), "git {args:?}");
        run(&main, &["init", "-q"]);
        run(&main, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one"]);
        run(&main, &["worktree", "add", "-q", "-b", "side", "../wt"]);
        (dir, main, wt)
    }

    #[test]
    fn a_linked_worktree_follows_its_own_git_directory_and_the_shared_refs() {
        let (_d, main, wt) = with_worktree();
        let own = main.join(".git/worktrees/wt");
        assert!(own.is_dir());
        let both = vec![Repo::of(main.clone()), Repo::of(wt.clone())];
        let to = |repos: &[Repo], p: PathBuf| classify(git(), repos, &[p]);
        assert_eq!(to(&both, own.join("HEAD")), BTreeSet::from([wt.clone()]), "its HEAD is its own");
        assert_eq!(to(&both, own.join("index")), BTreeSet::from([wt.clone()]));
        assert_eq!(to(&both, own.join("rebase-merge/msgnum")), BTreeSet::from([wt.clone()]));
        assert!(to(&both, own.join("index.lock")).is_empty());
        assert!(to(&both, own.join("logs/HEAD")).is_empty());
        assert_eq!(to(&both, main.join(".git/refs/heads/x")), BTreeSet::from([main.clone(), wt.clone()]), "refs are shared");
        assert_eq!(to(&both, main.join(".git/packed-refs")), BTreeSet::from([main.clone(), wt.clone()]));
        assert_eq!(to(&both, main.join(".git/HEAD")), BTreeSet::from([main.clone()]), "the main worktree's HEAD is its own");
        assert_eq!(to(&both, main.join(".git/index")), BTreeSet::from([main.clone()]));
        assert_eq!(to(&both, wt.join("src/a.rs")), BTreeSet::from([wt.clone()]));
        assert!(to(&both, wt.join(".git")).is_empty(), "the .git file");
        // Only the worktree watched: the main repository's own changes are nothing to it.
        let alone = vec![Repo::of(wt.clone())];
        assert_eq!(to(&alone, main.join(".git/refs/heads/x")), BTreeSet::from([wt.clone()]));
        assert!(to(&alone, main.join(".git/HEAD")).is_empty());
        assert!(to(&alone, main.join("README")).is_empty());
    }

    #[test]
    fn a_commit_in_a_linked_worktree_is_reported() {
        let (_d, main, wt) = with_worktree();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let _watcher = watch(Some(git_path()), vec![wt.clone()], true, move |changed| sink.lock().unwrap().push(changed)).unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let wait = |n: usize| {
            let deadline = Instant::now() + Duration::from_secs(5);
            while seen.lock().unwrap().len() < n && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            std::thread::sleep(Duration::from_millis(800));
        };
        // Everything a commit writes is outside the worktree's folder.
        assert!(Command::new(git_path()).args(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "two"]).current_dir(&wt).status().unwrap().success());
        wait(1);
        assert_eq!(*seen.lock().unwrap(), vec![BTreeSet::from([wt.clone()])], "a commit in the worktree");
        // A branch made from the main repository is a shared ref.
        assert!(Command::new(git_path()).args(["branch", "elsewhere"]).current_dir(&main).status().unwrap().success());
        wait(2);
        assert_eq!(seen.lock().unwrap().len(), 2, "a branch from the main repository: {:?}", seen.lock().unwrap());
    }

    #[test]
    fn a_missing_root_does_not_stop_the_others_from_being_watched() {
        let (_d, root) = repo();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let roots = vec![PathBuf::from("/nonexistent/gg-unmounted/repo"), root.clone()];
        let _watcher = watch(Some(git_path()), roots, true, move |changed| sink.lock().unwrap().push(changed)).unwrap();
        std::thread::sleep(Duration::from_millis(500));
        std::fs::write(root.join("file.txt"), "x").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while seen.lock().unwrap().is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(*seen.lock().unwrap(), vec![BTreeSet::from([root.clone()])]);
    }

    #[test]
    fn a_real_change_is_reported_once_per_burst_and_ignored_ones_never() {
        let (_d, root) = repo();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let _watcher = watch(Some(git_path()), vec![root.clone()], true, move |changed| sink.lock().unwrap().push(changed)).unwrap();
        std::thread::sleep(Duration::from_millis(500)); // FSEvents needs a moment to start
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::write(root.join("target/out.bin"), "x").unwrap();
        std::thread::sleep(Duration::from_millis(1200));
        assert!(seen.lock().unwrap().is_empty(), "ignored files must not refresh: {:?}", seen.lock().unwrap());
        for i in 0..5 {
            std::fs::write(root.join(format!("file{i}.txt")), "x").unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while seen.lock().unwrap().is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        std::thread::sleep(Duration::from_millis(800));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "one burst, one report: {seen:?}");
        assert_eq!(seen[0], BTreeSet::from([root.clone()]));
    }
}
