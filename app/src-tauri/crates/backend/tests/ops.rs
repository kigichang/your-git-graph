//! The operations (gg_backend::ops), the data-loss checks (loss) and the CLI reads (reads)
//! against real git, in throwaway repositories. The user's own git configuration is never
//! touched: GIT_CONFIG_GLOBAL points at a temporary file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use gg_backend::api::*;
use gg_backend::ops::identity::sync_global_author;
use gg_backend::ops::operate;
use gg_backend::reads::read_git;
use gg_backend::runtime::{LocalRuntime, Runtime};
use tokio::sync::watch;

struct World {
    root: tempfile::TempDir,
    global: PathBuf,
    git: PathBuf,
    counter: Mutex<u32>,
}

impl World {
    fn new() -> World {
        let root = tempfile::tempdir().unwrap();
        let global = root.path().join("global.gitconfig");
        std::fs::write(&global, "[user]\n\tname = Global User\n\temail = global@example.com\n[init]\n\tdefaultBranch = main\n").unwrap();
        let git = PathBuf::from(&gg_backend::git::locate_git().expect("these tests need git").path);
        World { root, global, git, counter: Mutex::new(0) }
    }

    fn env(&self) -> HashMap<String, String> {
        HashMap::from([
            ("GIT_CONFIG_GLOBAL".to_string(), self.global.display().to_string()),
            ("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string()),
            ("GIT_AUTHOR_DATE".to_string(), "1700000000 +0000".to_string()),
            ("GIT_COMMITTER_DATE".to_string(), "1700000000 +0000".to_string()),
        ])
    }

    /// git in `cwd`; panics unless it succeeds; the trimmed stdout.
    fn sh(&self, cwd: &Path, args: &[&str]) -> String {
        let out = Command::new(&self.git).args(args).current_dir(cwd).envs(self.env()).env("GIT_TERMINAL_PROMPT", "0").output().unwrap();
        assert!(out.status.success(), "git {args:?} in {}: {}", cwd.display(), String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    fn git_status(&self, cwd: &Path, args: &[&str]) -> i32 {
        Command::new(&self.git).args(args).current_dir(cwd).envs(self.env()).output().unwrap().status.code().unwrap_or(-1)
    }

    /// A repository with main: c1 → c2 → c3 (files a, b, c), pushed to a bare `origin`.
    fn fixture(&self) -> Fixture<'_> {
        let n = { let mut c = self.counter.lock().unwrap(); *c += 1; *c };
        let dir = self.root.path().join(format!("r{n}"));
        let remote = self.root.path().join(format!("r{n}-origin.git"));
        std::fs::create_dir(&dir).unwrap();
        self.sh(self.root.path(), &["init", "-q", "--bare", remote.to_str().unwrap()]);
        self.sh(&dir, &["init", "-q"]);
        for name in ["a", "b", "c"] {
            std::fs::write(dir.join(name), format!("{name}\n")).unwrap();
            self.sh(&dir, &["add", name]);
            self.sh(&dir, &["commit", "-qm", &format!("add {name}")]);
        }
        self.sh(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
        self.sh(&dir, &["push", "-q", "-u", "origin", "main"]);
        Fixture { world: self, dir, remote, n }
    }

    fn runtime(&self, dir: &Path) -> (LocalRuntime, Arc<Mutex<Vec<OpProgress>>>, Arc<Mutex<Vec<Vec<String>>>>) {
        let progress: Arc<Mutex<Vec<OpProgress>>> = Arc::default();
        let terminal: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
        let (tx, rx) = watch::channel(false);
        std::mem::forget(tx); // never cancelled
        let p = progress.clone();
        let t = terminal.clone();
        let rt = LocalRuntime::new(dir.to_str().unwrap(), self.git.clone(), self.env(), Arc::new(move |x| p.lock().unwrap().push(x)), rx)
            .with_terminal(Arc::new(move |args| { t.lock().unwrap().push(args); Ok(()) }));
        (rt, progress, terminal)
    }
}

struct Fixture<'a> {
    world: &'a World,
    dir: PathBuf,
    remote: PathBuf,
    n: u32,
}

impl Fixture<'_> {
    fn git(&self, args: &[&str]) -> String {
        self.world.sh(&self.dir, args)
    }
    fn write(&self, file: &str, text: &str) {
        std::fs::write(self.dir.join(file), text).unwrap();
    }
    fn commit(&self, name: &str) -> String {
        self.write(name, &format!("{name}\n"));
        self.git(&["add", name]);
        self.git(&["commit", "-qm", &format!("add {name}")]);
        self.git(&["rev-parse", "HEAD"])
    }
    fn subjects(&self) -> Vec<String> {
        self.git(&["log", "--format=%s"]).lines().map(String::from).collect()
    }
    fn rt(&self) -> LocalRuntime {
        self.world.runtime(&self.dir).0
    }
    async fn op(&self, request: OpRequest) -> OpResult {
        operate(&self.rt(), request, false).await.unwrap()
    }
    async fn op_confirmed(&self, request: OpRequest) -> OpResult {
        operate(&self.rt(), request, true).await.unwrap()
    }
    /// A second clone of the remote, to push from "someone else".
    fn other(&self) -> PathBuf {
        let other = self.world.root.path().join(format!("other{}", self.n));
        self.world.sh(self.world.root.path(), &["clone", "-q", self.remote.to_str().unwrap(), other.to_str().unwrap()]);
        other
    }
}

fn done(r: &OpResult) -> bool {
    *r == OpResult::Done
}
fn failed(r: &OpResult) -> &str {
    match r {
        OpResult::Failed { message, .. } => message,
        other => panic!("expected a failure, got {other:?}"),
    }
}
fn reasons(r: &OpResult) -> &[Reason] {
    match r {
        OpResult::NeedsConfirmation { reasons } => reasons,
        other => panic!("expected a question, got {other:?}"),
    }
}

/* ---------- branches ---------- */

#[tokio::test]
async fn create_checkout_rename_delete() {
    let w = World::new();
    let f = w.fixture();
    let c2 = f.git(&["rev-parse", "HEAD~1"]);
    assert!(done(&f.op(OpRequest::CreateBranch { branch: "feat".into(), commit: c2.clone(), checkout: true, force: false }).await));
    assert_eq!(f.git(&["branch", "--show-current"]), "feat");
    assert_eq!(f.git(&["rev-parse", "HEAD"]), c2);
    assert!(done(&f.op(OpRequest::RenameBranch { old_name: "feat".into(), new_name: "feat2".into() }).await));
    assert!(done(&f.op(OpRequest::CheckoutBranch { branch: "main".into(), remote_branch: None, pull_afterwards: None }).await));
    assert!(done(&f.op(OpRequest::DeleteBranch { branch: "feat2".into(), force: false, delete_on_remotes: vec![] }).await));
    assert_eq!(f.git(&["branch", "--list", "feat2"]), "");
}

#[tokio::test]
async fn an_unmerged_branch_needs_force_and_the_remote_copy_goes_too() {
    let w = World::new();
    let f = w.fixture();
    f.git(&["checkout", "-qb", "wip"]);
    f.commit("w");
    f.git(&["push", "-q", "origin", "wip"]);
    f.git(&["checkout", "-q", "main"]);
    let refused = f.op(OpRequest::DeleteBranch { branch: "wip".into(), force: false, delete_on_remotes: vec!["origin".into()] }).await;
    assert!(failed(&refused).contains("not fully merged"));
    assert_ne!(f.git(&["ls-remote", "--heads", "origin", "wip"]), "", "no remote deletion after a failed local one");
    assert!(done(&f.op(OpRequest::DeleteBranch { branch: "wip".into(), force: true, delete_on_remotes: vec!["origin".into()] }).await));
    assert_eq!(f.git(&["ls-remote", "--heads", "origin", "wip"]), "");
}

#[tokio::test]
async fn deleting_a_remote_branch_already_gone_removes_the_stale_tracking_branch() {
    let w = World::new();
    let f = w.fixture();
    f.git(&["push", "-q", "origin", "main:gone"]);
    f.git(&["fetch", "-q", "origin"]);
    w.sh(&f.remote, &["branch", "-D", "gone"]);
    assert!(done(&f.op(OpRequest::DeleteRemoteBranch { remote: "origin".into(), branch: "gone".into() }).await));
    assert_eq!(f.git(&["branch", "-r", "--list", "origin/gone"]), "");
}

#[tokio::test]
async fn check_out_a_remote_branch_as_tracking_and_a_commit_detached() {
    let w = World::new();
    let f = w.fixture();
    f.git(&["push", "-q", "origin", "main~1:refs/heads/older"]);
    f.git(&["fetch", "-q", "origin"]);
    assert!(done(&f.op(OpRequest::CheckoutBranch { branch: "older".into(), remote_branch: Some("origin/older".into()), pull_afterwards: None }).await));
    assert_eq!(f.git(&["rev-parse", "--abbrev-ref", "older@{upstream}"]), "origin/older");
    let c1 = f.git(&["rev-parse", "main~2"]);
    assert!(done(&f.op(OpRequest::CheckoutCommit { commit: c1.clone() }).await));
    assert_eq!(f.git(&["branch", "--show-current"]), "");
    assert_eq!(f.git(&["rev-parse", "HEAD"]), c1);
}

#[tokio::test]
async fn arguments_that_look_like_options_are_refused_before_git_runs() {
    let w = World::new();
    let f = w.fixture();
    let r = f.op(OpRequest::CreateBranch { branch: "--upload-pack=evil".into(), commit: "HEAD".into(), checkout: false, force: false }).await;
    assert!(failed(&r).contains("must not start with \"-\""));
    let r = f.op(OpRequest::Fetch { remote: Some("-oProxyCommand=x".into()), prune: false, prune_tags: false }).await;
    assert!(failed(&r).contains("must not start"));
    // A checkout of such a commit fails the same way, with no data-loss check run first.
    f.write("a", "changed\n");
    let r = f.op(OpRequest::CheckoutCommit { commit: "--upload-pack=x".into() }).await;
    assert!(failed(&r).contains("must not start"));
    assert_eq!(f.git(&["status", "--porcelain"]), "M a");
}

#[tokio::test]
async fn an_archive_path_that_looks_like_an_option_is_refused() {
    let w = World::new();
    let f = w.fixture();
    let r = f.op(OpRequest::CreateArchive { reference: "HEAD".into(), path: "-evil.zip".into() }).await;
    assert!(failed(&r).contains("must not start"));
    assert!(!f.dir.join("-evil.zip").exists());
}

/// A repository's own config can name a program as `core.fsmonitor`: showing the repository
/// must not start it.
#[tokio::test]
async fn reads_do_not_run_the_fsmonitor_a_repository_names() {
    let w = World::new();
    let f = w.fixture();
    let marker = f.dir.join(".git/ran");
    let program = f.dir.join(".git/monitor.sh");
    std::fs::write(&program, format!("#!/bin/sh\ntouch '{}'\nexit 1\n", marker.display())).unwrap();
    std::fs::set_permissions(&program, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    f.git(&["config", "core.fsmonitor", program.to_str().unwrap()]);
    f.git(&["diff", "--cached", "--quiet", "--no-ext-diff"]);
    assert!(marker.exists(), "plain git runs it: this test would show nothing otherwise");
    std::fs::remove_file(&marker).unwrap();

    let state = read_git(&f.rt(), ReadRequest::OperationState).await.unwrap();
    assert!(matches!(state, ReadResponse::OperationState { staged: false, .. }));
    assert!(done(&f.op(OpRequest::CreateBranch { branch: "side".into(), commit: "HEAD".into(), checkout: false, force: false }).await));
    assert!(!marker.exists());
}

/* ---------- tags ---------- */

#[tokio::test]
async fn annotated_and_lightweight_tags_and_deleting_on_the_remote() {
    let w = World::new();
    let f = w.fixture();
    let head = f.git(&["rev-parse", "HEAD"]);
    let r = f.op(OpRequest::AddTag { tag: "v1".into(), commit: head.clone(), tag_kind: TagKind::Annotated, message: "release 1".into(), force: false, push_to: Some("origin".into()) }).await;
    assert!(done(&r), "{r:?}");
    assert_eq!(f.git(&["cat-file", "-t", "v1"]), "tag");
    assert_eq!(f.git(&["tag", "-l", "--format=%(contents:subject)", "v1"]), "release 1");
    assert_ne!(f.git(&["ls-remote", "--tags", "origin", "v1"]), "");
    assert!(done(&f.op(OpRequest::AddTag { tag: "light".into(), commit: head, tag_kind: TagKind::Lightweight, message: String::new(), force: false, push_to: None }).await));
    assert_eq!(f.git(&["cat-file", "-t", "light"]), "commit");
    assert!(done(&f.op(OpRequest::DeleteTag { tag: "v1".into(), delete_on_remote: Some("origin".into()) }).await));
    assert_eq!(f.git(&["tag", "-l", "v1"]), "");
    assert_eq!(f.git(&["ls-remote", "--tags", "origin", "v1"]), "");
}

#[tokio::test]
async fn pushing_a_tag_whose_commit_is_not_on_the_remote_asks_first() {
    let w = World::new();
    let f = w.fixture();
    let head = f.commit("d");
    let add = OpRequest::AddTag { tag: "t".into(), commit: head.clone(), tag_kind: TagKind::Lightweight, message: String::new(), force: false, push_to: Some("origin".into()) };
    let r = f.op(add.clone()).await;
    assert_eq!(reasons(&r), [Reason::TagCommitNotOnRemote { remotes: vec!["origin".into()] }]);
    assert_eq!(f.git(&["tag", "-l", "t"]), "", "nothing ran");
    assert!(done(&f.op_confirmed(add).await));
    assert_ne!(f.git(&["ls-remote", "--tags", "origin", "t"]), "", "confirmed: created and pushed");
    f.git(&["tag", "t2", &head]);
    let push = OpRequest::PushTag { tag: "t2".into(), commit: head, remotes: vec!["origin".into()] };
    assert_eq!(reasons(&f.op(push.clone()).await).len(), 1);
    assert!(done(&f.op_confirmed(push).await));
}

/* ---------- remotes ---------- */

#[tokio::test]
async fn push_with_upstream_fetch_with_prune_pull_with_squash() {
    let w = World::new();
    let f = w.fixture();
    f.git(&["checkout", "-qb", "topic"]);
    let (rt, progress, _) = w.runtime(&f.dir);
    assert!(done(&operate(&rt, OpRequest::Push { branch: "topic".into(), remotes: vec!["origin".into()], set_upstream: true, mode: PushMode::Normal }, false).await.unwrap()));
    assert_eq!(f.git(&["rev-parse", "--abbrev-ref", "topic@{upstream}"]), "origin/topic");
    assert!(progress.lock().unwrap().iter().any(|p| matches!(p, OpProgress::Output { .. })), "a push streams its output");

    w.sh(&f.remote, &["branch", "-D", "topic"]);
    assert!(done(&f.op(OpRequest::Fetch { remote: None, prune: true, prune_tags: false }).await));
    assert_eq!(f.git(&["branch", "-r", "--list", "origin/topic"]), "");

    // Someone else adds two commits to origin/main; pull them squashed into one.
    let other = f.other();
    for n in ["x", "y"] {
        std::fs::write(other.join(n), format!("{n}\n")).unwrap();
        w.sh(&other, &["add", n]);
        w.sh(&other, &["commit", "-qm", &format!("remote {n}")]);
    }
    w.sh(&other, &["push", "-q", "origin", "main"]);
    f.git(&["checkout", "-q", "main"]);
    let before = f.git(&["rev-parse", "HEAD"]);
    assert!(done(&f.op(OpRequest::Pull { remote: "origin".into(), branch: "main".into(), no_fast_forward: false, squash: true }).await));
    assert_eq!(f.git(&["rev-parse", "HEAD~1"]), before, "exactly one new commit");
    assert!(f.dir.join("x").exists() && f.dir.join("y").exists());
}

#[tokio::test]
async fn add_edit_prune_and_delete_a_remote() {
    let w = World::new();
    let f = w.fixture();
    let remote = f.remote.display().to_string();
    assert!(done(&f.op(OpRequest::AddRemote { name: "up".into(), url: remote.clone(), push_url: Some("/push/url".into()), fetch: true }).await));
    assert_eq!(f.git(&["config", "remote.up.pushurl"]), "/push/url");
    assert_ne!(f.git(&["branch", "-r", "--list", "up/main"]), "", "fetched");
    let edit = OpRequest::EditRemote { name_old: "up".into(), name_new: "up2".into(), url_old: Some(remote), url_new: Some("/new/url".into()), push_url_old: Some("/push/url".into()), push_url_new: None };
    assert!(done(&f.op(edit).await));
    assert_eq!(f.git(&["config", "remote.up2.url"]), "/new/url");
    assert_eq!(w.git_status(&f.dir, &["config", "remote.up2.pushurl"]), 1, "push URL removed");
    assert!(done(&f.op(OpRequest::PruneRemote { name: "origin".into() }).await));
    assert!(done(&f.op(OpRequest::DeleteRemote { name: "up2".into() }).await));
    assert_eq!(f.git(&["remote"]), "origin");
}

/* ---------- merge, rebase, cherry-pick, revert ---------- */

/// main gets m1, side (from c3) gets s1 + s2 touching other files.
fn diverged(w: &World) -> Fixture<'_> {
    let f = w.fixture();
    f.git(&["checkout", "-qb", "side"]);
    f.commit("s1");
    f.commit("s2");
    f.git(&["checkout", "-q", "main"]);
    f.commit("m1");
    f
}

#[tokio::test]
async fn merge_a_merge_commit_or_one_squashed_commit() {
    let w = World::new();
    let f = diverged(&w);
    assert!(done(&f.op(OpRequest::Merge { target: "side".into(), no_fast_forward: true, squash: false, no_commit: false }).await));
    assert_eq!(f.git(&["rev-list", "--parents", "-n", "1", "HEAD"]).split(' ').count(), 3);

    let g = diverged(&w);
    let before = g.git(&["rev-parse", "HEAD"]);
    assert!(done(&g.op(OpRequest::Merge { target: "side".into(), no_fast_forward: false, squash: true, no_commit: false }).await));
    assert_eq!(g.git(&["rev-parse", "HEAD~1"]), before);
    assert_eq!(g.git(&["rev-list", "--parents", "-n", "1", "HEAD"]).split(' ').count(), 2, "not a merge commit");
}

#[tokio::test]
async fn a_conflicting_merge_reports_its_state_and_abort_restores_the_branch() {
    let w = World::new();
    let f = w.fixture();
    f.git(&["checkout", "-qb", "other"]);
    f.write("a", "other\n");
    f.git(&["commit", "-qam", "other a"]);
    f.git(&["checkout", "-q", "main"]);
    f.write("a", "main\n");
    f.git(&["commit", "-qam", "main a"]);
    let head = f.git(&["rev-parse", "HEAD"]);
    let r = f.op(OpRequest::Merge { target: "other".into(), no_fast_forward: false, squash: false, no_commit: false }).await;
    assert!(failed(&r).contains("CONFLICT"));
    let rt = f.rt();
    let ReadResponse::OperationState { operation, conflicted_files, progress, .. } = read_git(&rt, ReadRequest::OperationState).await.unwrap() else { panic!() };
    assert_eq!((operation, conflicted_files, progress), (Some(OperationKind::Merge), vec!["a".to_string()], None));
    let ReadResponse::ConflictPrediction { prediction } = read_git(&rt, ReadRequest::PredictConflicts { ours: "main".into(), theirs: "other".into() }).await.unwrap() else { panic!() };
    assert_eq!(prediction, Some(ConflictPrediction { conflicted: true, files: vec!["a".into()] }));
    assert!(done(&f.op(OpRequest::AbortOperation { operation: OperationKind::Merge }).await));
    assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
    let ReadResponse::OperationState { operation, .. } = read_git(&rt, ReadRequest::OperationState).await.unwrap() else { panic!() };
    assert_eq!(operation, None);
}

#[tokio::test]
async fn continue_a_conflicted_rebase_after_resolving_it() {
    let w = World::new();
    let f = w.fixture();
    f.git(&["checkout", "-qb", "other"]);
    f.write("a", "other\n");
    f.git(&["commit", "-qam", "other a"]);
    f.git(&["checkout", "-q", "main"]);
    f.write("a", "main\n");
    f.git(&["commit", "-qam", "main a"]);
    assert!(!done(&f.op(OpRequest::Rebase { onto: "other".into(), ignore_date: false, autosquash: false, interactive: false }).await));
    let ReadResponse::OperationState { operation, conflicted_files, .. } = read_git(&f.rt(), ReadRequest::OperationState).await.unwrap() else { panic!() };
    assert_eq!((operation, conflicted_files), (Some(OperationKind::Rebase), vec!["a".to_string()]));
    f.write("a", "resolved\n");
    f.git(&["add", "a"]);
    assert!(done(&f.op(OpRequest::ContinueOperation { operation: OperationKind::Rebase }).await));
    assert_eq!(&f.subjects()[..2], ["main a", "other a"]);
}

#[tokio::test]
async fn rebase_plain_autosquash_and_interactive_handed_to_the_terminal() {
    let w = World::new();
    let f = diverged(&w);
    f.git(&["checkout", "-q", "side"]);
    assert!(done(&f.op(OpRequest::Rebase { onto: "main".into(), ignore_date: false, autosquash: false, interactive: false }).await));
    assert_eq!(&f.subjects()[..3], ["add s2", "add s1", "add m1"]);

    let s1 = f.git(&["rev-parse", "HEAD~1"]);
    let staged = || async { matches!(read_git(&f.rt(), ReadRequest::OperationState).await.unwrap(), ReadResponse::OperationState { staged: true, .. }) };
    f.write("s1", "s1 fixed\n");
    assert!(!staged().await, "changed but not staged: nothing for fixup");
    f.git(&["add", "s1"]);
    assert!(staged().await);
    assert!(done(&f.op(OpRequest::CommitFixup { commit: s1 }).await));
    assert_eq!(f.subjects()[0], "fixup! add s1");
    assert!(!staged().await, "committed");
    assert!(done(&f.op(OpRequest::Rebase { onto: "main".into(), ignore_date: false, autosquash: true, interactive: false }).await));
    assert_eq!(&f.subjects()[..3], ["add s2", "add s1", "add m1"]);
    assert_eq!(f.git(&["show", "HEAD~1:s1"]), "s1 fixed");

    let (rt, _, terminal) = w.runtime(&f.dir);
    assert!(done(&operate(&rt, OpRequest::Rebase { onto: "main".into(), ignore_date: true, autosquash: false, interactive: true }, false).await.unwrap()));
    assert_eq!(*terminal.lock().unwrap(), vec![vec!["rebase".to_string(), "-i".into(), "--ignore-date".into(), "main".into()]]);
}

#[tokio::test]
async fn cherry_pick_with_origin_recorded_and_revert() {
    let w = World::new();
    let f = diverged(&w);
    let s1 = f.git(&["rev-parse", "side~1"]);
    assert!(done(&f.op(OpRequest::CherryPick { commit: s1.clone(), parent_index: 0, record_origin: true, no_commit: false }).await));
    assert!(f.git(&["log", "-1", "--format=%B"]).contains(&format!("cherry picked from commit {s1}")));
    assert!(done(&f.op(OpRequest::Revert { commit: "HEAD".into(), parent_index: 0 }).await));
    assert!(f.subjects()[0].starts_with("Revert \"add s1\""));
    assert!(!f.dir.join("s1").exists());
}

#[tokio::test]
async fn squash_commit_for_staged_changes() {
    let w = World::new();
    let f = w.fixture();
    let c2 = f.git(&["rev-parse", "HEAD~1"]);
    f.write("b", "b2\n");
    f.git(&["add", "b"]);
    assert!(done(&f.op(OpRequest::CommitSquash { commit: c2 }).await));
    assert_eq!(f.subjects()[0], "squash! add b");
}

/* ---------- rewriting commits ---------- */

#[tokio::test]
async fn edit_the_message_of_head_with_a_new_author() {
    let w = World::new();
    let f = w.fixture();
    let head = f.git(&["rev-parse", "HEAD"]);
    let author = Author { name: "New Name".into(), email: "new@example.com".into() };
    assert!(done(&f.op(OpRequest::EditCommitMessage { commit: head, message: "new\n\nbody".into(), author: Some(author) }).await));
    assert_eq!(f.git(&["log", "-1", "--format=%B"]), "new\n\nbody");
    assert_eq!(f.git(&["log", "-1", "--format=%an <%ae>"]), "New Name <new@example.com>");
}

#[tokio::test]
async fn edit_the_message_of_an_older_commit_keeping_the_later_ones_and_the_tree() {
    let w = World::new();
    let f = w.fixture();
    f.write("dirty", "uncommitted\n");
    f.git(&["add", "dirty"]); // autostashed and restored
    let tree = f.git(&["rev-parse", "HEAD^{tree}"]);
    let c2 = f.git(&["rev-parse", "HEAD~1"]);
    assert!(done(&f.op(OpRequest::EditCommitMessage { commit: c2, message: "b, reworded \"quoted\" $HOME".into(), author: None }).await));
    assert_eq!(f.subjects(), ["add c", "b, reworded \"quoted\" $HOME", "add a"]);
    assert_eq!(f.git(&["rev-parse", "HEAD^{tree}"]), tree);
    assert_eq!(f.git(&["status", "--porcelain"]), "A  dirty");
}

#[tokio::test]
async fn edit_the_root_commit_and_drop_commits() {
    let w = World::new();
    let f = w.fixture();
    let root = f.git(&["rev-list", "--max-parents=0", "HEAD"]);
    assert!(done(&f.op(OpRequest::EditCommitMessage { commit: root, message: "root".into(), author: None }).await));
    assert_eq!(f.subjects(), ["add c", "add b", "root"]);

    let g = w.fixture();
    let c2 = g.git(&["rev-parse", "HEAD~1"]);
    assert!(done(&g.op(OpRequest::DropCommit { commit: c2 }).await));
    assert_eq!(g.subjects(), ["add c", "add a"]);
    assert!(!g.dir.join("b").exists());
    let root = g.git(&["rev-list", "--max-parents=0", "HEAD"]);
    assert!(done(&g.op(OpRequest::DropCommit { commit: root }).await));
    assert_eq!(g.subjects(), ["add c"]);
}

#[tokio::test]
async fn rewriting_refuses_merges_in_the_range_and_commits_off_the_branch() {
    let w = World::new();
    let f = w.fixture();
    let c1 = f.git(&["rev-parse", "HEAD~2"]);
    f.git(&["checkout", "-qb", "x", "HEAD~1"]);
    let x = f.commit("x");
    f.git(&["checkout", "-q", "main"]);
    f.git(&["merge", "-q", "--no-ff", "-m", "merge x", "x"]);
    assert!(failed(&f.op(OpRequest::DropCommit { commit: c1 }).await).contains("merge commits"));
    f.git(&["reset", "-q", "--hard", "HEAD~1"]);
    assert!(failed(&f.op(OpRequest::EditCommitMessage { commit: x, message: "m".into(), author: None }).await).contains("not on the checked-out branch"));
}

#[tokio::test]
async fn reset_modes_and_undo_last_commit() {
    let w = World::new();
    let f = w.fixture();
    let c2 = f.git(&["rev-parse", "HEAD~1"]);
    assert!(done(&f.op(OpRequest::UndoLastCommit).await));
    assert_eq!(f.git(&["rev-parse", "HEAD"]), c2);
    assert_eq!(f.git(&["status", "--porcelain"]), "A  c", "the undone commit stays staged");
    // origin/main still holds every commit: a hard reset asks only about the staged change.
    let r = f.op(OpRequest::Reset { commit: "HEAD~1".into(), mode: ResetMode::Hard }).await;
    assert_eq!(reasons(&r), [Reason::UncommittedDiscarded { count: 1 }]);
    assert!(done(&f.op_confirmed(OpRequest::Reset { commit: "HEAD~1".into(), mode: ResetMode::Hard }).await));
    assert_eq!(f.git(&["status", "--porcelain"]), "");
}

/* ---------- stashes and the working tree ---------- */

#[tokio::test]
async fn push_apply_pop_branch_from_and_drop_stashes() {
    let w = World::new();
    let f = w.fixture();
    f.write("a", "changed\n");
    f.write("new", "untracked\n");
    assert!(done(&f.op(OpRequest::StashPush { message: "first".into(), include_untracked: true }).await));
    assert_eq!(f.git(&["status", "--porcelain"]), "");
    assert!(f.git(&["stash", "list"]).contains("first"));
    assert!(done(&f.op(OpRequest::StashApply { selector: "stash@{0}".into(), reinstate_index: false }).await));
    assert!(f.dir.join("new").exists());
    f.git(&["reset", "-q", "--hard"]);
    f.git(&["clean", "-qfd"]);
    assert!(done(&f.op(OpRequest::BranchFromStash { branch: "from-stash".into(), selector: "stash@{0}".into() }).await));
    assert_eq!(f.git(&["branch", "--show-current"]), "from-stash");
    assert_eq!(f.git(&["stash", "list"]), "", "stash branch drops the stash");
    f.write("b", "again\n");
    assert!(done(&f.op(OpRequest::StashPush { message: String::new(), include_untracked: false }).await));
    assert!(done(&f.op(OpRequest::StashPop { selector: "stash@{0}".into(), reinstate_index: false }).await));
    assert!(done(&f.op(OpRequest::StashPush { message: "drop me".into(), include_untracked: false }).await));
    assert!(done(&f.op(OpRequest::StashDrop { selector: "stash@{0}".into() }).await));
    assert_eq!(f.git(&["stash", "list"]), "");
}

#[tokio::test]
async fn clean_untracked_files_reset_one_file_create_an_archive() {
    let w = World::new();
    let f = w.fixture();
    std::fs::create_dir(f.dir.join("tmpdir")).unwrap();
    f.write("tmpdir/x", "x");
    f.write("loose", "l");
    assert!(done(&f.op(OpRequest::CleanUntracked { directories: true }).await));
    assert_eq!(f.git(&["status", "--porcelain"]), "");
    f.write("a", "edited\n");
    assert!(done(&f.op(OpRequest::ResetFile { commit: "HEAD".into(), path: "a".into() }).await));
    assert_eq!(std::fs::read_to_string(f.dir.join("a")).unwrap(), "a\n");
    let zip = w.root.path().join("archive.zip");
    assert!(done(&f.op(OpRequest::CreateArchive { reference: "main".into(), path: zip.display().to_string() }).await));
    assert_eq!(&std::fs::read(&zip).unwrap()[..2], b"PK");
    // Not for a repository on another machine: the archive would land over there.
    let (_tx, rx) = watch::channel(false);
    let remote = LocalRuntime::new(f.dir.to_str().unwrap(), w.git.clone(), w.env(), Arc::new(|_| {}), rx).remote();
    assert!(failed(&operate(&remote, OpRequest::CreateArchive { reference: "main".into(), path: zip.display().to_string() }, false).await.unwrap()).contains("another machine"));
}

#[tokio::test]
async fn worktrees_add_with_a_new_branch_list_remove_prune() {
    let w = World::new();
    let f = w.fixture();
    let wt = w.root.path().join(format!("wt{}", f.n));
    assert!(done(&f.op(OpRequest::WorktreeAdd { path: wt.display().to_string(), branch: Some("main".into()), new_branch: Some("wt-branch".into()) }).await));
    let rt = f.rt();
    let ReadResponse::Worktrees { worktrees } = read_git(&rt, ReadRequest::WorktreeList).await.unwrap() else { panic!() };
    assert_eq!(worktrees.len(), 2);
    assert!(worktrees[0].is_main);
    let second = &worktrees[1];
    assert_eq!(std::fs::canonicalize(&second.path).unwrap(), std::fs::canonicalize(&wt).unwrap());
    assert_eq!(second.hash, f.git(&["rev-parse", "main"]));
    assert_eq!((second.branch.as_deref(), second.detached, second.locked, second.prunable, second.is_main), (Some("wt-branch"), false, false, false, false));
    assert!(done(&f.op(OpRequest::WorktreeRemove { path: wt.display().to_string(), force: false }).await));
    assert!(done(&f.op(OpRequest::WorktreePrune).await));
    let ReadResponse::Worktrees { worktrees } = read_git(&rt, ReadRequest::WorktreeList).await.unwrap() else { panic!() };
    assert_eq!(worktrees.len(), 1);
}

/* ---------- reads ---------- */

#[tokio::test]
async fn reflog_with_dangling_entries() {
    let w = World::new();
    let f = w.fixture();
    let c3 = f.git(&["rev-parse", "HEAD"]);
    f.git(&["reset", "-q", "--hard", "HEAD~1"]); // c3 is now reachable from origin/main only
    f.git(&["commit", "-q", "--allow-empty", "-m", "lost"]);
    let lost = f.git(&["rev-parse", "HEAD"]);
    f.git(&["reset", "-q", "--hard", "HEAD~1"]); // `lost` is reachable from nothing
    let rt = f.rt();
    let ReadResponse::Reflog { entries, more } = read_git(&rt, ReadRequest::Reflog { reference: "HEAD".into(), limit: 2 }).await.unwrap() else { panic!() };
    assert!(more);
    assert_eq!(entries.iter().map(|e| (e.selector.as_str(), e.dangling)).collect::<Vec<_>>(), [("HEAD@{0}", false), ("HEAD@{1}", true)]);
    assert_eq!(entries[1].hash, lost);
    assert!(entries[0].message.starts_with("reset: moving to HEAD~1"), "{}", entries[0].message);
    assert!(entries[0].date > 1_600_000_000);
    let ReadResponse::Reflog { entries, more } = read_git(&rt, ReadRequest::Reflog { reference: "HEAD".into(), limit: 50 }).await.unwrap() else { panic!() };
    assert!(!more);
    assert!(!entries.iter().find(|e| e.hash == c3).unwrap().dangling);
    assert!(read_git(&rt, ReadRequest::Reflog { reference: "--all".into(), limit: 5 }).await.is_err());
}

#[tokio::test]
async fn predict_a_clean_merge_and_ahead_behind() {
    let w = World::new();
    let f = w.fixture();
    f.git(&["branch", "other", "HEAD~1"]);
    let rt = f.rt();
    let ReadResponse::ConflictPrediction { prediction } = read_git(&rt, ReadRequest::PredictConflicts { ours: "main".into(), theirs: "other".into() }).await.unwrap() else { panic!() };
    assert_eq!(prediction, Some(ConflictPrediction { conflicted: false, files: vec![] }));
    let ReadResponse::AheadBehind { ahead, behind } = read_git(&rt, ReadRequest::AheadBehind).await.unwrap() else { panic!() };
    assert_eq!((ahead, behind), (Some(0), Some(0)));
    f.commit("d");
    f.git(&["reset", "-q", "--hard", "HEAD~2"]);
    let ReadResponse::AheadBehind { ahead, behind } = read_git(&rt, ReadRequest::AheadBehind).await.unwrap() else { panic!() };
    assert_eq!((ahead, behind), (Some(0), Some(1)));
    f.git(&["checkout", "-qb", "nowhere"]);
    let ReadResponse::AheadBehind { ahead, behind } = read_git(&rt, ReadRequest::AheadBehind).await.unwrap() else { panic!() };
    assert_eq!((ahead, behind), (None, None), "no upstream");
}

#[tokio::test]
async fn repository_config_remotes_branches_user_and_authors() {
    let w = World::new();
    let f = w.fixture();
    f.git(&["config", "user.name", "Local User"]);
    f.git(&["config", "remote.pushDefault", "origin"]);
    let ReadResponse::RepoConfig { config } = read_git(&f.rt(), ReadRequest::RepoConfig).await.unwrap() else { panic!() };
    assert_eq!(config.remotes, [RemoteConfig { name: "origin".into(), url: Some(f.remote.display().to_string()), push_url: None }]);
    assert_eq!(config.branches.get("main"), Some(&BranchConfig { remote: Some("origin".into()), push_remote: None }));
    assert_eq!(config.user_name, LocalAndGlobal { local: Some("Local User".into()), global: Some("Global User".into()) });
    assert_eq!(config.user_email, LocalAndGlobal { local: None, global: Some("global@example.com".into()) });
    assert_eq!(config.push_default.as_deref(), Some("origin"));
    assert_eq!(config.authors, [Author { name: "Global User".into(), email: "global@example.com".into() }]);
}

#[tokio::test]
async fn edit_and_delete_user_details_global_goes_to_the_temp_global_config() {
    let w = World::new();
    let f = w.fixture();
    f.git(&["config", "user.name", "Old Local"]);
    let r = f.op(OpRequest::EditUserDetails { name: "--unset-all".into(), email: "-l".into(), location: ConfigLocation::Global, delete_local_name: false, delete_local_email: false }).await;
    assert!(done(&r), "{r:?}");
    assert_eq!(w.sh(w.root.path(), &["config", "--global", "user.name"]), "--unset-all", "a value after the key is not read as an option");
    assert_eq!(w.sh(w.root.path(), &["config", "--global", "user.email"]), "-l");
    assert!(done(&f.op(OpRequest::EditUserDetails { name: "G".into(), email: "g@example.com".into(), location: ConfigLocation::Global, delete_local_name: true, delete_local_email: true }).await));
    assert_eq!(w.sh(w.root.path(), &["config", "--global", "user.name"]), "G");
    assert_eq!(w.git_status(&f.dir, &["config", "--local", "user.name"]), 1);
    assert!(done(&f.op(OpRequest::DeleteUserDetails { name: true, email: false, location: ConfigLocation::Global }).await));
    assert_eq!(w.git_status(w.root.path(), &["config", "--global", "user.name"]), 1);
}

/* ---------- data-loss questions ---------- */

#[tokio::test]
async fn a_hard_reset_over_uncommitted_changes_and_unpushed_commits_asks_then_runs() {
    let w = World::new();
    let f = w.fixture();
    let c3 = f.git(&["rev-parse", "HEAD"]);
    f.commit("d"); // not on origin
    f.write("a", "changed\n");
    let reset = OpRequest::Reset { commit: c3.clone(), mode: ResetMode::Hard };
    let r = f.op(reset.clone()).await;
    assert_eq!(reasons(&r), [Reason::ResetDropsCommits { count: 1, branch: "main".into() }, Reason::UncommittedDiscarded { count: 1 }]);
    assert_ne!(f.git(&["rev-parse", "HEAD"]), c3, "nothing ran");
    assert!(done(&f.op_confirmed(reset).await));
    assert_eq!(f.git(&["rev-parse", "HEAD"]), c3);
}

#[tokio::test]
async fn resets_that_lose_nothing_just_run() {
    let w = World::new();
    let f = w.fixture();
    let c1 = f.git(&["rev-list", "--max-parents=0", "HEAD"]);
    f.write("a", "changed\n");
    assert!(done(&f.op(OpRequest::Reset { commit: c1, mode: ResetMode::Mixed }).await), "origin/main still holds c2 and c3; mixed keeps the change");
}

#[tokio::test]
async fn leaving_a_detached_head_with_commits_of_its_own_asks_from_every_way_out() {
    let w = World::new();
    let f = w.fixture();
    let c1 = f.git(&["rev-list", "--max-parents=0", "HEAD"]);
    let rt = f.rt();
    assert!(gg_backend::loss::reasons(&rt, &OpRequest::CheckoutCommit { commit: c1.clone() }).await.unwrap().is_empty(), "on a branch: nothing to lose");
    f.git(&["checkout", "-q", "--detach"]);
    assert!(gg_backend::loss::reasons(&rt, &OpRequest::CheckoutCommit { commit: c1.clone() }).await.unwrap().is_empty(), "detached on main's commit");
    f.commit("lonely");
    for request in [
        OpRequest::CheckoutCommit { commit: c1.clone() },
        OpRequest::CheckoutBranch { branch: "main".into(), remote_branch: None, pull_afterwards: None },
        OpRequest::CreateBranch { branch: "elsewhere".into(), commit: c1.clone(), checkout: true, force: false },
    ] {
        let r = f.op(request.clone()).await;
        assert_eq!(reasons(&r), [Reason::DetachedCommits { count: 1 }], "{request:?}");
    }
    assert!(done(&f.op(OpRequest::CreateBranch { branch: "keep".into(), commit: c1, checkout: false, force: false }).await), "no checkout: HEAD stays");
    assert!(done(&f.op_confirmed(OpRequest::CheckoutBranch { branch: "main".into(), remote_branch: None, pull_afterwards: None }).await));
    assert_eq!(f.git(&["symbolic-ref", "--short", "HEAD"]), "main");
}

#[tokio::test]
async fn force_moving_a_branch_asks_about_the_commits_only_it_holds() {
    let w = World::new();
    let f = w.fixture();
    let c1 = f.git(&["rev-list", "--max-parents=0", "HEAD"]);
    f.git(&["checkout", "-q", "-b", "x&y"]);
    f.commit("side");
    f.git(&["checkout", "-q", "main"]);
    let request = OpRequest::CreateBranch { branch: "x&y".into(), commit: c1, checkout: false, force: true };
    assert_eq!(reasons(&f.op(request.clone()).await), [Reason::BranchMoveDropsCommits { count: 1, branch: "x&y".into() }]);
    f.git(&["branch", "copy", "x&y"]);
    assert!(done(&f.op(request).await), "another branch holds it now");
}

#[tokio::test]
async fn a_force_push_that_drops_commits_from_the_remote_asks_a_normal_push_does_not() {
    let w = World::new();
    let f = w.fixture();
    f.git(&["reset", "-q", "--hard", "HEAD~1"]);
    let push = OpRequest::Push { branch: "main".into(), remotes: vec!["origin".into()], set_upstream: false, mode: PushMode::ForceWithLease };
    assert_eq!(reasons(&f.op(push.clone()).await), [Reason::ForcePushDropsCommits { count: 1, remote_branch: "origin/main".into(), branch: "main".into() }]);
    let normal = OpRequest::Push { branch: "main".into(), remotes: vec!["origin".into()], set_upstream: false, mode: PushMode::Normal };
    assert!(gg_backend::loss::reasons(&f.rt(), &normal).await.unwrap().is_empty());
    assert!(done(&f.op_confirmed(push).await));
    assert_eq!(f.git(&["rev-parse", "origin/main"]), f.git(&["rev-parse", "main"]));
}

/* ---------- the global author follows the author identities ---------- */

#[tokio::test]
async fn the_global_author_follows_the_identities() {
    let w = World::new();
    let f = w.fixture();
    let rt = f.rt();
    let global = |w: &World| {
        let get = |k: &str| {
            let out = Command::new(&w.git).args(["config", "--global", "--get", k]).envs(w.env()).output().unwrap();
            if out.status.success() { Some(String::from_utf8(out.stdout).unwrap().trim().to_string()) } else { None }
        };
        (get("user.name"), get("user.email"))
    };
    let a = Author { name: "Ann".into(), email: "ann@example.com".into() };
    let b = Author { name: "Bo".into(), email: "bo@example.com".into() };
    // A global author of the user's own is never replaced.
    assert!(!sync_global_author(&rt, &[], &[a.clone(), b.clone()]).await.unwrap());
    assert_eq!(global(&w), (Some("Global User".into()), Some("global@example.com".into())));
    // With no global author the first identity becomes it; edits and deletes carry over.
    std::fs::write(&w.global, "[init]\n\tdefaultBranch = main\n").unwrap();
    assert!(sync_global_author(&rt, &[], &[a.clone(), b.clone()]).await.unwrap());
    assert_eq!(global(&w), (Some("Ann".into()), Some("ann@example.com".into())));
    assert!(!sync_global_author(&rt, &[a.clone(), b.clone()], &[b.clone(), a.clone()]).await.unwrap(), "still one of them");
    let a2 = Author { name: "Ann Lee".into(), email: "ann@example.com".into() };
    assert!(sync_global_author(&rt, &[a.clone(), b.clone()], &[a2.clone(), b.clone()]).await.unwrap());
    assert_eq!(global(&w).0.as_deref(), Some("Ann Lee"), "an edit is followed");
    assert!(sync_global_author(&rt, &[a2.clone(), b.clone()], &[b.clone()]).await.unwrap());
    assert_eq!(global(&w).0.as_deref(), Some("Bo"), "deleted: the first remaining takes over");
    assert!(sync_global_author(&rt, &[b.clone()], &[]).await.unwrap());
    assert_eq!(global(&w), (None, None), "none left: unset");
    assert!(!sync_global_author(&rt, &[], &[]).await.unwrap());
    assert!(done(&f.op(OpRequest::SyncGlobalAuthor { previous: vec![], next: vec![a] }).await));
    assert_eq!(global(&w).0.as_deref(), Some("Ann"));
}

/* ---------- conventions ---------- */

#[tokio::test]
async fn every_git_run_is_non_interactive_and_takes_no_optional_locks_and_can_be_cancelled() {
    let w = World::new();
    let f = w.fixture();
    let rt = f.rt();
    let r = rt.git(vec!["-c".into(), "alias.e=!echo \"$GIT_EDITOR $GIT_OPTIONAL_LOCKS $GIT_TERMINAL_PROMPT\"".into(), "e".into()], Default::default()).await.unwrap();
    assert_eq!(r.stdout, "true 0 0\n");

    let (tx, rx) = watch::channel(false);
    let rt = LocalRuntime::new(f.dir.to_str().unwrap(), w.git.clone(), w.env(), Arc::new(|_| {}), rx);
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let _ = tx.send(true);
    });
    let started = std::time::Instant::now();
    let r = rt.git(vec!["-c".into(), "alias.s=!sleep 30".into(), "s".into()], Default::default()).await.unwrap();
    assert!(r.cancelled);
    assert!(started.elapsed().as_secs() < 5);
    assert!(rt.cancelled());
    assert_eq!(rt.git(vec!["status".into()], Default::default()).await.unwrap_err(), "Cancelled.", "nothing more runs");
}

/* ---------- the commit list ---------- */

#[tokio::test]
async fn the_list_shows_the_author_date_when_asked_and_the_committer_date_otherwise() {
    let w = World::new();
    let f = w.fixture();
    f.git(&["commit", "-q", "--allow-empty", "-m", "written long before", "--date=1600000000 +0000"]);
    f.write("a", "changed\n");
    let rt = f.rt();
    let mut options = LoadOptions {
        max_commits: 10, branches: None, authors: None, filter_paths: vec![], order: CommitOrder::Date, first_parent_only: false,
        show_tags: true, show_remote_branches: true, show_remote_heads: true, hide_remotes: vec![], show_uncommitted: true, show_untracked: true,
        author_dates: false, include_reflog: false,
    };
    let list = |r: ReadResponse| match r {
        ReadResponse::Commits { commits, timing, .. } => (commits.into_iter().map(|c| (c.hash, c.message, c.date)).collect::<Vec<_>>(), timing),
        other => panic!("{other:?}"),
    };
    let (commits, timing) = list(gg_backend::api::read(&rt, ReadRequest::Commits { options: options.clone() }).await.unwrap());
    assert_eq!(commits[0].0, UNCOMMITTED);
    assert_eq!((commits[1].1.as_str(), commits[1].2), ("written long before", 1_700_000_000), "the engine lists the committer date");
    assert_eq!(timing.dates_ms, 0.0);

    options.author_dates = true;
    let (dated, timing) = list(gg_backend::api::read(&rt, ReadRequest::Commits { options }).await.unwrap());
    assert_eq!(dated[0], commits[0], "the uncommitted row keeps its date");
    assert_eq!((dated[1].1.as_str(), dated[1].2), ("written long before", 1_600_000_000), "the author date");
    assert!(dated[2..].iter().all(|c| c.2 == 1_700_000_000));
    assert!(timing.dates_ms > 0.0);
}

#[tokio::test]
async fn commits_only_the_reflog_mentions_come_in_before_their_parents_without_the_stash_internals() {
    let w = World::new();
    let f = w.fixture();
    f.commit("d");
    f.git(&["reset", "-q", "--hard", "HEAD~1"]); // "add d" is only in the reflog now
    f.write("a", "stashed\n");
    f.git(&["stash", "-q"]);
    f.write("a", "stashed again\n");
    f.git(&["stash", "-q"]);
    let rt = f.rt();
    let options = |include_reflog: bool, branches: Option<Vec<String>>| LoadOptions {
        max_commits: 50, branches, authors: None, filter_paths: vec![], order: CommitOrder::Date, first_parent_only: false,
        show_tags: true, show_remote_branches: true, show_remote_heads: true, hide_remotes: vec![], show_uncommitted: false, show_untracked: false,
        author_dates: false, include_reflog,
    };
    let load = |o: LoadOptions| async {
        match gg_backend::api::read(&rt, ReadRequest::Commits { options: o }).await.unwrap() {
            ReadResponse::Commits { commits, layout, timing, .. } => (commits, layout, timing),
            other => panic!("{other:?}"),
        }
    };
    let subjects = |commits: &[Commit]| commits.iter().map(|c| c.message.clone()).collect::<Vec<_>>();

    let (plain, _, timing) = load(options(false, None)).await;
    assert!(!subjects(&plain).contains(&"add d".to_string()));
    assert_eq!(timing.reflog_ms, 0.0);

    let (with, layout, timing) = load(options(true, None)).await;
    let s = subjects(&with);
    assert_eq!(s.iter().filter(|m| *m == "add d").count(), 1, "{s:?}");
    let d = s.iter().position(|m| m == "add d").unwrap();
    let c = s.iter().position(|m| m == "add c").unwrap();
    assert!(d < c, "before its parent: {s:?}");
    assert!(with[d].heads.is_empty() && with[d].stash.is_none());
    assert_eq!(with.iter().filter(|c| c.stash.is_some()).count(), 2, "the two stashes, as rows");
    assert!(!s.iter().any(|m| m.starts_with("index on")), "not the stashes' own commits: {s:?}");
    assert_eq!(with.len(), plain.len() + 1);
    assert_eq!(layout.node_lane.len(), with.len(), "laid out again");
    assert!(timing.reflog_ms > 0.0);

    // A branch filter shows that branch's history: no reflog.
    let (filtered, _, _) = load(options(true, Some(vec!["main".into()]))).await;
    assert!(!subjects(&filtered).contains(&"add d".to_string()));
}
