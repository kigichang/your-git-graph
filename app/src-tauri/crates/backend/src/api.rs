//! The requests the front end makes of a repository, and their answers, as types: the app's
//! commands take and return these, and so does the remote helper (wire op `read`). The
//! TypeScript side is generated from them (`cargo test` writes web/src/lib/api/generated/).
//!
//! The reads here are answered by the engine. Those that need the git CLI (the reflog, the
//! worktrees, conflict prediction, the repository's configuration) come with the runtime that
//! runs git (M3).

use std::collections::{BTreeMap, HashMap};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

use crate::graph::{self, Layout, Row};

/// The hash of the row that stands for the uncommitted changes.
pub const UNCOMMITTED: &str = "*";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum CommitOrder {
    #[default]
    Date,
    AuthorDate,
    Topo,
}

/// What to load into the graph.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct LoadOptions {
    pub max_commits: u32,
    /// The branches to show (`None`: all), as the branch filter names them.
    pub branches: Option<Vec<String>>,
    pub authors: Option<Vec<String>>,
    pub filter_paths: Vec<String>,
    pub order: CommitOrder,
    pub first_parent_only: bool,
    pub show_tags: bool,
    pub show_remote_branches: bool,
    pub show_remote_heads: bool,
    pub hide_remotes: Vec<String>,
    pub show_uncommitted: bool,
    pub show_untracked: bool,
    /// Each commit's `date` is its author date (setting `commits.dateType` = `author`); false:
    /// its committer date, which is what the engine lists.
    pub author_dates: bool,
    /// Also the commits only reflogs mention (setting `commits.includeReflog`); not with a
    /// branch filter.
    pub include_reflog: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct CommitStash {
    pub selector: String,
    pub base_hash: String,
    pub untracked_files_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum ReadRequest {
    /// The branches, remotes, stashes and tags, and the checked-out branch.
    RepoInfo { show_remote_branches: bool, show_remote_heads: bool, hide_remotes: Vec<String>, show_stashes: bool },
    Commits { options: LoadOptions },
    CommitDetails { hash: String },
    StashDetails { hash: String, stash: CommitStash },
    UncommittedDetails,
    /// The files that differ between two revisions (`to` may be [`UNCOMMITTED`]).
    Compare { from: String, to: String },
    /// The `+n −m` of files between `from` (`None`: the empty tree) and `to`.
    LineCounts { from: Option<String>, to: String, paths: Vec<String> },
    TagDetails { name: String },
    /// How many commits of the graph come before `hash` (to scroll to one that is not loaded).
    CountCommitsBefore { hash: String, branches: Option<Vec<String>>, show_remote_branches: bool },
    Authors,
    /* Answered by the git CLI (reads.rs). */
    /// What is in progress (merge, rebase, …) and which files conflict.
    OperationState,
    /// The reflog of `reference` (`HEAD`, a branch): at most `limit` entries.
    Reflog { reference: String, limit: u32 },
    WorktreeList,
    /// Whether merging `theirs` into `ours` would conflict, and in which files.
    PredictConflicts { ours: String, theirs: String },
    /// The repository's remotes, branch upstreams, user and tools, from its config.
    RepoConfig,
    /// How far the checked-out branch is ahead of / behind its upstream.
    AheadBehind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct OperationProgress {
    pub step: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct ReflogEntry {
    pub hash: String,
    pub abbrev: String,
    /// `HEAD@{3}`
    pub selector: String,
    #[ts(type = "number")]
    pub date: i64,
    pub message: String,
    /// Reachable from no ref any more.
    pub dangling: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct Worktree {
    pub path: String,
    pub hash: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub locked: bool,
    pub prunable: bool,
    pub is_main: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct ConflictPrediction {
    pub conflicted: bool,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct RemoteConfig {
    pub name: String,
    pub url: Option<String>,
    pub push_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct BranchConfig {
    pub remote: Option<String>,
    pub push_remote: Option<String>,
}

/// A config value as set in the repository and in the user's global configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct LocalAndGlobal {
    pub local: Option<String>,
    pub global: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct RepoConfig {
    pub remotes: Vec<RemoteConfig>,
    pub branches: BTreeMap<String, BranchConfig>,
    pub user_name: LocalAndGlobal,
    pub user_email: LocalAndGlobal,
    pub push_default: Option<String>,
    pub diff_tool: Option<String>,
    pub gui_diff_tool: Option<String>,
    pub authors: Vec<Author>,
}

/* ---------- Operations ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum TagKind {
    Annotated,
    Lightweight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum PushMode {
    Normal,
    Force,
    ForceWithLease,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

/// An operation git leaves in progress on a conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum OperationKind {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

impl OperationKind {
    pub fn git_name(self) -> &'static str {
        match self {
            OperationKind::Merge => "merge",
            OperationKind::Rebase => "rebase",
            OperationKind::CherryPick => "cherry-pick",
            OperationKind::Revert => "revert",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum ConfigLocation {
    Local,
    Global,
}

/// A pull to run once a branch is checked out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct PullAfter {
    pub remote: String,
    pub branch: String,
    pub no_fast_forward: bool,
    pub squash: bool,
}

/// What the person asks to be done to the repository. Every value that reaches git's command
/// line is checked first: one starting with `-` is refused.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum OpRequest {
    /* Remotes */
    AddRemote { name: String, url: String, push_url: Option<String>, fetch: bool },
    EditRemote { name_old: String, name_new: String, url_old: Option<String>, url_new: Option<String>, push_url_old: Option<String>, push_url_new: Option<String> },
    DeleteRemote { name: String },
    PruneRemote { name: String },
    /// `remote` `None`: all of them.
    Fetch { remote: Option<String>, prune: bool, prune_tags: bool },
    FetchIntoLocalBranch { remote: String, remote_branch: String, local_branch: String, force: bool },
    Pull { remote: String, branch: String, no_fast_forward: bool, squash: bool },
    Push { branch: String, remotes: Vec<String>, set_upstream: bool, mode: PushMode },
    /* Tags */
    AddTag { tag: String, commit: String, tag_kind: TagKind, message: String, force: bool, push_to: Option<String> },
    DeleteTag { tag: String, delete_on_remote: Option<String> },
    PushTag { tag: String, commit: String, remotes: Vec<String> },
    /* Branches */
    CreateBranch { branch: String, commit: String, checkout: bool, force: bool },
    /// `remote_branch` set: a new local branch tracking it.
    CheckoutBranch { branch: String, remote_branch: Option<String>, pull_afterwards: Option<PullAfter> },
    CheckoutCommit { commit: String },
    DeleteBranch { branch: String, force: bool, delete_on_remotes: Vec<String> },
    DeleteRemoteBranch { remote: String, branch: String },
    RenameBranch { old_name: String, new_name: String },
    /* Merging and rewriting */
    Merge { target: String, no_fast_forward: bool, squash: bool, no_commit: bool },
    Rebase { onto: String, ignore_date: bool, autosquash: bool, interactive: bool },
    CherryPick { commit: String, parent_index: u32, record_origin: bool, no_commit: bool },
    Revert { commit: String, parent_index: u32 },
    ContinueOperation { operation: OperationKind },
    AbortOperation { operation: OperationKind },
    Reset { commit: String, mode: ResetMode },
    UndoLastCommit,
    DropCommit { commit: String },
    EditCommitMessage { commit: String, message: String, author: Option<Author> },
    CommitFixup { commit: String },
    CommitSquash { commit: String },
    /* Stashes */
    StashPush { message: String, include_untracked: bool },
    StashApply { selector: String, reinstate_index: bool },
    StashPop { selector: String, reinstate_index: bool },
    StashDrop { selector: String },
    BranchFromStash { branch: String, selector: String },
    /* The working tree */
    CleanUntracked { directories: bool },
    ResetFile { commit: String, path: String },
    /// Write `reference` as a zip at `path` (on this machine: refused for a remote repository).
    CreateArchive { reference: String, path: String },
    /* Worktrees */
    WorktreeAdd { path: String, branch: Option<String>, new_branch: Option<String> },
    WorktreeRemove { path: String, force: bool },
    WorktreePrune,
    /* Identity */
    EditUserDetails { name: String, email: String, location: ConfigLocation, delete_local_name: bool, delete_local_email: bool },
    DeleteUserDetails { name: bool, email: bool, location: ConfigLocation },
    /// The author identities of the settings changed from `previous` to `next`: keep the
    /// global author in step (see `ops::identity`).
    SyncGlobalAuthor { previous: Vec<Author>, next: Vec<Author> },
}

/// Why an operation asks before running: work it would leave hard to find, or a tag whose
/// commit the remote does not have. The front end words these.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum Reason {
    /// HEAD is detached on `count` commits no branch, tag or remote-tracking branch holds.
    DetachedCommits { count: u32 },
    /// The reset leaves `count` commits of `branch` on no other ref.
    ResetDropsCommits { count: u32, branch: String },
    /// A hard reset discards `count` uncommitted changes to tracked files.
    UncommittedDiscarded { count: u32 },
    /// Moving `branch` leaves `count` of its commits on no other ref.
    BranchMoveDropsCommits { count: u32, branch: String },
    /// A force push removes `count` commits of `remote_branch` that `branch` lacks.
    ForcePushDropsCommits { count: u32, remote_branch: String, branch: String },
    /// The tag's commit is not on these remotes yet.
    TagCommitNotOnRemote { remotes: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum OpResult {
    Done,
    /// Not run: the person has to confirm first (`confirmed: true` on the next call).
    NeedsConfirmation { reasons: Vec<Reason> },
    /// `step` names what failed when the operation had several (the tag was created but not
    /// pushed, say); `message` is git's.
    Failed { message: String, step: Option<String> },
}

/// What an operation reports while it runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum OpProgress {
    /// A chunk of git's output (fetch and push stream theirs).
    Output { stderr: bool, text: String },
    /// Of an operation in several steps (a push to each remote): which one is starting.
    Step { index: u32, total: u32, label: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct CommitTag {
    pub name: String,
    pub annotated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct CommitRemote {
    pub name: String,
    /// `None` when the ref's remote is not one of the repository's remotes.
    pub remote: Option<String>,
}

/// One row of the graph, as the engine describes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Seconds since the Unix epoch.
    #[ts(type = "number")]
    pub date: i64,
    /// The subject (first line of the message).
    pub message: String,
    pub heads: Vec<String>,
    pub tags: Vec<CommitTag>,
    pub remotes: Vec<CommitRemote>,
    pub stash: Option<CommitStash>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct Stash {
    pub hash: String,
    pub base_hash: String,
    pub untracked_files_hash: Option<String>,
    pub selector: String,
    pub author: String,
    pub email: String,
    #[ts(type = "number")]
    pub date: i64,
    pub message: String,
}

/// Added, modified, deleted, renamed, untracked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum FileStatus {
    A,
    M,
    D,
    R,
    U,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct FileChange {
    pub old_path: String,
    pub new_path: String,
    pub status: FileStatus,
    /// `None` until counted (see [`ReadRequest::LineCounts`]), and for a binary file.
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct Details {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    #[ts(type = "number")]
    pub author_date: i64,
    pub committer: String,
    pub committer_email: String,
    #[ts(type = "number")]
    pub committer_date: i64,
    /// The whole message, subject included.
    pub body: String,
    pub files: Vec<FileChange>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct LineCounts {
    /// Both `None` for a binary file.
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct TagDetails {
    /// The tag object of an annotated tag; the commit of a lightweight one.
    pub hash: String,
    pub tagger: String,
    pub tagger_email: String,
    #[ts(type = "number")]
    pub tagger_date: i64,
    pub message: String,
    pub annotated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct Author {
    pub name: String,
    pub email: String,
}

/// How long the parts of a read took, for the performance gate.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct Timing {
    pub engine_ms: f64,
    pub layout_ms: f64,
    /// Reading the author dates (`LoadOptions::author_dates`); 0 without.
    pub dates_ms: f64,
    /// Adding the commits only reflogs mention (`LoadOptions::include_reflog`); 0 without.
    pub reflog_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum ReadResponse {
    RepoInfo { branches: Vec<String>, head: Option<String>, remotes: Vec<String>, stashes: Vec<Stash>, tags: Vec<String> },
    Commits { commits: Vec<Commit>, head: Option<String>, more: bool, layout: Layout, timing: Timing },
    Details { details: Details },
    Compare { files: Vec<FileChange> },
    LineCounts { counts: BTreeMap<String, LineCounts> },
    TagDetails { details: TagDetails },
    Count {
        #[ts(type = "number")]
        count: u64,
    },
    Authors { authors: Vec<Author> },
    /// `staged`: the index has changes to commit.
    OperationState { operation: Option<OperationKind>, progress: Option<OperationProgress>, conflicted_files: Vec<String>, staged: bool },
    Reflog { entries: Vec<ReflogEntry>, more: bool },
    Worktrees { worktrees: Vec<Worktree> },
    /// `None` when git cannot tell.
    ConflictPrediction { prediction: Option<ConflictPrediction> },
    RepoConfig { config: RepoConfig },
    /// `None` without an upstream.
    AheadBehind { ahead: Option<u32>, behind: Option<u32> },
}

impl ReadRequest {
    /// Whether the engine answers it (else the git CLI, through a runtime).
    pub fn is_engine(&self) -> bool {
        !matches!(
            self,
            ReadRequest::OperationState | ReadRequest::Reflog { .. } | ReadRequest::WorktreeList | ReadRequest::PredictConflicts { .. } | ReadRequest::RepoConfig | ReadRequest::AheadBehind
        )
    }
}

/// The engine's answer to one call, or its in-band failure (`{"error": "Kind: message"}`).
pub fn engine_call(repo: &str, method: &str, params: Value) -> Result<Value, String> {
    let request = json!({ "method": method, "params": params }).to_string();
    let answer: Value = serde_json::from_str(&crate::engine(repo, &request)).map_err(|e| format!("The engine's answer is not JSON: {e}"))?;
    match answer.as_object() {
        Some(fields) if fields.len() == 1 => match fields.get("error") {
            Some(Value::String(message)) => Err(message.clone()),
            _ => Ok(answer),
        },
        _ => Ok(answer),
    }
}

fn engine_typed<T: serde::de::DeserializeOwned>(repo: &str, method: &str, params: Value) -> Result<T, String> {
    serde_json::from_value(engine_call(repo, method, params)?).map_err(|e| format!("{method}: {e}"))
}

/* ---------- The engine's shapes, where they differ from ours ---------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineCommits {
    commits: Vec<Commit>,
    head: Option<String>,
    more_commits_available: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineRepoInfo {
    branches: Vec<String>,
    head: Option<String>,
    remotes: Vec<String>,
    stashes: Vec<Stash>,
    tags: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineFileChange {
    old_file_path: String,
    new_file_path: String,
    #[serde(rename = "type")]
    status: FileStatus,
    additions: Option<u32>,
    deletions: Option<u32>,
}

impl From<EngineFileChange> for FileChange {
    fn from(f: EngineFileChange) -> FileChange {
        FileChange { old_path: f.old_file_path, new_path: f.new_file_path, status: f.status, additions: f.additions, deletions: f.deletions }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineDetails {
    hash: String,
    parents: Vec<String>,
    author: String,
    author_email: String,
    author_date: i64,
    committer: String,
    committer_email: String,
    committer_date: i64,
    body: String,
    file_changes: Vec<EngineFileChange>,
}

impl From<EngineDetails> for Details {
    fn from(d: EngineDetails) -> Details {
        Details {
            hash: d.hash,
            parents: d.parents,
            author: d.author,
            author_email: d.author_email,
            author_date: d.author_date,
            committer: d.committer,
            committer_email: d.committer_email,
            committer_date: d.committer_date,
            body: d.body,
            files: d.file_changes.into_iter().map(FileChange::from).collect(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineTagDetails {
    hash: String,
    tagger_name: String,
    tagger_email: String,
    tagger_date: i64,
    message: String,
}

/// Answer `request` for the repository `rt` runs in: the engine's reads in a blocking task,
/// the CLI's through the runtime's git.
pub async fn read(rt: &dyn crate::runtime::Runtime, request: ReadRequest) -> Result<ReadResponse, String> {
    if request.is_engine() {
        let options = match &request {
            ReadRequest::Commits { options } => Some(options.clone()),
            _ => None,
        };
        let repo = rt.repo().to_string();
        let mut response = tokio::task::spawn_blocking(move || read_engine(&repo, request)).await.map_err(|e| e.to_string())??;
        if let (Some(o), ReadResponse::Commits { commits, timing, layout, more, .. }) = (options, &mut response) {
            // The engine's dates are the committer's: the reflog's commits go by them too.
            if o.include_reflog && o.branches.is_none() {
                let started = Instant::now();
                match crate::reflogged::add(rt, &o, commits, *more).await {
                    Ok(0) => {}
                    Ok(_) => *layout = layout_of(commits, *more, &o),
                    Err(e) => eprintln!("[reflog] {e}"),
                }
                timing.reflog_ms = started.elapsed().as_secs_f64() * 1000.0;
            }
            if o.author_dates {
                let started = Instant::now();
                use_author_dates(rt, commits).await;
                timing.dates_ms = started.elapsed().as_secs_f64() * 1000.0;
            }
        }
        return Ok(response);
    }
    crate::reads::read_git(rt, request).await
}

/// Author dates already read, by commit hash: a commit's date never changes, so a reload or a
/// longer page asks git only for the commits it has not seen. Shared by every repository (a
/// hash names one commit wherever it is); 86k commits take about 8 MB.
static AUTHOR_DATES: std::sync::LazyLock<std::sync::Mutex<HashMap<String, i64>>> = std::sync::LazyLock::new(Default::default);

/// Give each listed commit its author date: the engine's list carries the committer date only.
/// The dates not known yet come from one `git log --no-walk --stdin` (the hashes as its input:
/// as arguments, git takes ten times longer for a long list); a commit git cannot answer for
/// keeps the committer date.
async fn use_author_dates(rt: &dyn crate::runtime::Runtime, commits: &mut [Commit]) {
    let missing: Vec<&str> = {
        let known = AUTHOR_DATES.lock().unwrap();
        commits.iter().filter(|c| c.hash != UNCOMMITTED && !known.contains_key(&c.hash)).map(|c| c.hash.as_str()).collect()
    };
    if !missing.is_empty() {
        let args = ["log", "--no-walk=unsorted", "--stdin", "--no-show-signature", "--format=%H %at"].map(String::from).to_vec();
        let opts = crate::runtime::GitOpts { stdin: Some(missing.join("\n") + "\n"), ..Default::default() };
        match rt.git(args, opts).await {
            Ok(out) if out.exit_code == Some(0) => AUTHOR_DATES.lock().unwrap().extend(author_dates_of(&out.stdout)),
            Ok(out) => eprintln!("[author dates] git log failed: {}", out.stderr.trim()),
            Err(e) => eprintln!("[author dates] {e}"),
        }
    }
    let known = AUTHOR_DATES.lock().unwrap();
    for commit in commits.iter_mut() {
        if let Some(date) = known.get(&commit.hash) {
            commit.date = *date;
        }
    }
}

/// `<hash> <seconds>` per line.
fn author_dates_of(stdout: &str) -> impl Iterator<Item = (String, i64)> + '_ {
    stdout.lines().filter_map(|line| {
        let (hash, seconds) = line.split_once(' ')?;
        Some((hash.to_string(), seconds.trim().parse().ok()?))
    })
}

/// The lanes of `commits`. A filtered history (by author or path) leaves parents out for good:
/// those fade; otherwise a parent beyond a page runs on to the bottom.
fn layout_of(commits: &[Commit], more: bool, o: &LoadOptions) -> Layout {
    let rows: Vec<Row> = commits.iter().map(|c| Row { hash: &c.hash, parents: &c.parents }).collect();
    let filtered = o.authors.as_ref().is_some_and(|a| !a.is_empty()) || !o.filter_paths.is_empty();
    graph::layout(&rows, more && !filtered)
}

/// Answer an engine read for the local repository at `repo` (a CLI one is an error).
pub fn read_engine(repo: &str, request: ReadRequest) -> Result<ReadResponse, String> {
    match request {
        ReadRequest::RepoInfo { show_remote_branches, show_remote_heads, hide_remotes, show_stashes } => {
            let info: EngineRepoInfo = engine_typed(
                repo,
                "loadRepoInfo",
                json!({ "showRemoteBranches": show_remote_branches, "showRemoteHeads": show_remote_heads, "hideRemotes": hide_remotes,
                    "showChangeRefs": false, "showStashes": show_stashes }),
            )?;
            Ok(ReadResponse::RepoInfo { branches: info.branches, head: info.head, remotes: info.remotes, stashes: info.stashes, tags: info.tags })
        }
        ReadRequest::Commits { options: o } => {
            let started = Instant::now();
            let params = json!({
                "branches": o.branches, "authors": o.authors, "maxCommits": o.max_commits,
                "showTags": o.show_tags, "showRemoteBranches": o.show_remote_branches, "showRemoteHeads": o.show_remote_heads,
                "deferRemoteRefs": false, "includeCommitsMentionedByReflogs": false,
                "onlyFollowFirstParent": o.first_parent_only, "commitOrdering": o.order,
                "remotes": [], "hideRemotes": o.hide_remotes, "gerritRefs": null, "gerritShowChangeRefs": false,
                "filterPaths": o.filter_paths, "deferUncommittedChanges": false,
                "showUncommittedChanges": o.show_uncommitted, "showUntrackedFiles": o.show_untracked,
                "showCommitsOnlyReferencedByTags": true, "useMailmap": false
            });
            let data: EngineCommits = engine_typed(repo, "loadCommits", params)?;
            let engine_ms = started.elapsed().as_secs_f64() * 1000.0;
            let started = Instant::now();
            let layout = layout_of(&data.commits, data.more_commits_available, &o);
            let layout_ms = started.elapsed().as_secs_f64() * 1000.0;
            Ok(ReadResponse::Commits {
                commits: data.commits,
                head: data.head,
                more: data.more_commits_available,
                layout,
                timing: Timing { engine_ms, layout_ms, dates_ms: 0.0, reflog_ms: 0.0 },
            })
        }
        ReadRequest::CommitDetails { hash } => {
            let d: EngineDetails = engine_typed(repo, "loadCommitDetails", json!({ "hash": hash }))?;
            Ok(ReadResponse::Details { details: d.into() })
        }
        ReadRequest::StashDetails { hash, stash } => {
            let d: EngineDetails = engine_typed(repo, "loadStashDetails", json!({ "hash": hash, "stash": stash }))?;
            Ok(ReadResponse::Details { details: d.into() })
        }
        ReadRequest::UncommittedDetails => {
            let d: EngineDetails = engine_typed(repo, "loadUncommittedDetails", Value::Null)?;
            Ok(ReadResponse::Details { details: d.into() })
        }
        ReadRequest::Compare { from, to } => {
            let to = if to == UNCOMMITTED { String::new() } else { to };
            let files: Vec<EngineFileChange> = engine_typed(repo, "compareCommits", json!({ "from": from, "to": to }))?;
            Ok(ReadResponse::Compare { files: files.into_iter().map(FileChange::from).collect() })
        }
        ReadRequest::LineCounts { from, to, paths } => {
            let counts: BTreeMap<String, LineCounts> = engine_typed(repo, "loadLineCounts", json!({ "from": from, "to": to, "paths": paths }))?;
            Ok(ReadResponse::LineCounts { counts })
        }
        ReadRequest::TagDetails { name } => {
            let t: EngineTagDetails = engine_typed(repo, "loadTagDetails", json!({ "tagName": name }))?;
            // A lightweight tag has no tagger of its own: the engine leaves the name empty.
            let annotated = !t.tagger_name.is_empty() || !t.tagger_email.is_empty();
            Ok(ReadResponse::TagDetails {
                details: TagDetails { hash: t.hash, tagger: t.tagger_name, tagger_email: t.tagger_email, tagger_date: t.tagger_date, message: t.message, annotated },
            })
        }
        ReadRequest::CountCommitsBefore { hash, branches, show_remote_branches } => {
            let count: u64 = engine_typed(
                repo,
                "countCommitsBefore",
                json!({ "branches": branches, "hash": hash, "showRemoteBranches": show_remote_branches, "includeReflogs": false }),
            )?;
            Ok(ReadResponse::Count { count })
        }
        ReadRequest::Authors => {
            let authors: Vec<Author> = engine_typed(repo, "authors", Value::Null)?;
            Ok(ReadResponse::Authors { authors })
        }
        other => Err(format!("{} is not an engine read", serde_json::to_string(&other).unwrap_or_default())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    fn options(max: u32) -> LoadOptions {
        LoadOptions {
            max_commits: max,
            branches: None,
            authors: None,
            filter_paths: vec![],
            order: CommitOrder::Date,
            first_parent_only: false,
            show_tags: true,
            show_remote_branches: true,
            show_remote_heads: true,
            hide_remotes: vec![],
            show_uncommitted: false,
            show_untracked: false,
            author_dates: false,
            include_reflog: false,
        }
    }

    /// main: one — three — merge(side: two); a tag on "one"; a stash; an uncommitted change.
    fn repository() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        std::fs::write(p.join("a"), "1\n").unwrap();
        git(p, &["add", "a"]);
        git(p, &["commit", "-q", "-m", "one"]);
        git(p, &["tag", "-a", "-m", "the first", "v1"]);
        git(p, &["tag", "light"]);
        git(p, &["checkout", "-q", "-b", "side"]);
        std::fs::write(p.join("b"), "2\n").unwrap();
        git(p, &["add", "b"]);
        git(p, &["commit", "-q", "-m", "two"]);
        git(p, &["checkout", "-q", "main"]);
        std::fs::write(p.join("c"), "3\n3\n").unwrap();
        git(p, &["add", "c"]);
        git(p, &["commit", "-q", "-m", "three\n\nwith a body"]);
        git(p, &["merge", "-q", "--no-ff", "-m", "merge", "side"]);
        std::fs::write(p.join("a"), "stashed\n").unwrap();
        git(p, &["stash", "push", "-q", "-m", "kept"]);
        std::fs::write(p.join("a"), "changed\n").unwrap();
        std::fs::write(p.join("new"), "untracked\n").unwrap();
        dir
    }

    #[test]
    fn commits_come_with_their_layout_and_the_uncommitted_row_on_top() {
        let dir = repository();
        let repo = dir.path().to_str().unwrap();
        let ReadResponse::Commits { commits, head, more, layout, timing } = read_engine(repo, ReadRequest::Commits { options: options(300) }).unwrap() else { panic!() };
        assert_eq!(commits.iter().map(|c| c.message.as_str()).collect::<Vec<_>>(), ["On main: kept", "merge", "three", "two", "one"]);
        assert!(commits[0].stash.is_some(), "the stash is a row");
        assert_eq!(commits[1].parents.len(), 2);
        assert_eq!(commits[1].heads, ["main"]);
        assert_eq!(commits[4].tags.iter().map(|t| (t.name.as_str(), t.annotated)).collect::<Vec<_>>(), [("light", false), ("v1", true)]);
        assert_eq!(head.as_deref(), Some(commits[1].hash.as_str()));
        assert!(!more);
        assert_eq!(layout.node_lane.len(), 5);
        assert!(timing.engine_ms > 0.0);

        let mut with_changes = options(300);
        with_changes.show_uncommitted = true;
        with_changes.show_untracked = true;
        let ReadResponse::Commits { commits, .. } = read_engine(repo, ReadRequest::Commits { options: with_changes }).unwrap() else { panic!() };
        assert_eq!(commits[0].hash, UNCOMMITTED);
        assert_eq!(commits[0].parents, [head.unwrap()]);

        // A page: the missing parent runs on (more to load) - no dangling edge.
        let ReadResponse::Commits { commits, more, layout, .. } = read_engine(repo, ReadRequest::Commits { options: options(2) }).unwrap() else { panic!() };
        assert_eq!(commits.len(), 3, "two commits and the stash on top");
        assert!(more);
        assert!(layout.dangling.is_empty());
        assert!(layout.spans.chunks(graph::SPAN).any(|s| s[1] == 2), "a line runs off the bottom");

        assert!(read_engine("/nonexistent", ReadRequest::Commits { options: options(1) }).is_err());
    }

    #[test]
    fn the_other_reads() {
        let dir = repository();
        let p = dir.path();
        let repo = p.to_str().unwrap();
        let head = git(p, &["rev-parse", "HEAD"]);
        let three = git(p, &["rev-parse", "HEAD^1"]);

        let ReadResponse::RepoInfo { branches, head: current, remotes, stashes, tags } =
            read_engine(repo, ReadRequest::RepoInfo { show_remote_branches: true, show_remote_heads: false, hide_remotes: vec![], show_stashes: true }).unwrap()
        else { panic!() };
        assert_eq!(branches, ["main", "side"]);
        assert_eq!(current.as_deref(), Some("main"));
        assert!(remotes.is_empty());
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].message, "On main: kept");
        assert_eq!(tags, ["light", "v1"]);

        let ReadResponse::Details { details } = read_engine(repo, ReadRequest::CommitDetails { hash: three.clone() }).unwrap() else { panic!() };
        assert_eq!(details.body, "three\n\nwith a body");
        assert_eq!(details.author, "t");
        assert_eq!(details.files.len(), 1);
        assert_eq!((details.files[0].new_path.as_str(), details.files[0].status), ("c", FileStatus::A));
        assert_eq!(details.files[0].additions, None, "counted separately");

        let ReadResponse::LineCounts { counts } =
            read_engine(repo, ReadRequest::LineCounts { from: Some(details.parents[0].clone()), to: three.clone(), paths: vec!["c".into()] }).unwrap()
        else { panic!() };
        assert_eq!(counts["c"], LineCounts { additions: Some(2), deletions: Some(0) });

        let ReadResponse::Details { details } = read_engine(repo, ReadRequest::UncommittedDetails).unwrap() else { panic!() };
        assert_eq!(details.hash, UNCOMMITTED);
        let mut names: Vec<(String, FileStatus)> = details.files.iter().map(|f| (f.new_path.clone(), f.status)).collect();
        names.sort();
        assert_eq!(names, [("a".to_string(), FileStatus::M), ("new".to_string(), FileStatus::U)]);

        let ReadResponse::Details { details } = read_engine(repo, ReadRequest::StashDetails {
            hash: stashes[0].hash.clone(),
            stash: CommitStash { selector: stashes[0].selector.clone(), base_hash: stashes[0].base_hash.clone(), untracked_files_hash: None },
        })
        .unwrap() else { panic!() };
        assert_eq!(details.files.iter().map(|f| f.new_path.as_str()).collect::<Vec<_>>(), ["a"]);

        let ReadResponse::Compare { files } = read_engine(repo, ReadRequest::Compare { from: three.clone(), to: head.clone() }).unwrap() else { panic!() };
        assert_eq!(files.iter().map(|f| f.new_path.as_str()).collect::<Vec<_>>(), ["b"]);
        let ReadResponse::Compare { files } = read_engine(repo, ReadRequest::Compare { from: head.clone(), to: UNCOMMITTED.into() }).unwrap() else { panic!() };
        assert!(files.iter().any(|f| f.new_path == "a" && f.status == FileStatus::M));

        let ReadResponse::TagDetails { details } = read_engine(repo, ReadRequest::TagDetails { name: "v1".into() }).unwrap() else { panic!() };
        assert!(details.annotated);
        assert_eq!(details.message.trim(), "the first");
        assert_eq!(details.tagger, "t");
        let ReadResponse::TagDetails { details } = read_engine(repo, ReadRequest::TagDetails { name: "light".into() }).unwrap() else { panic!() };
        assert!(!details.annotated);

        let ReadResponse::Count { count } = read_engine(repo, ReadRequest::CountCommitsBefore { hash: three.clone(), branches: None, show_remote_branches: true }).unwrap() else { panic!() };
        assert_eq!(count, 2, "the stash row and the merge come before 'three'");

        let ReadResponse::Authors { authors } = read_engine(repo, ReadRequest::Authors).unwrap() else { panic!() };
        assert_eq!(authors, [Author { name: "t".into(), email: "t@t".into() }]);
    }

    #[test]
    fn the_request_types_round_trip_as_tagged_json() {
        let req = ReadRequest::Commits { options: options(10) };
        let text = serde_json::to_string(&req).unwrap();
        assert!(text.starts_with("{\"kind\":\"commits\",\"options\":{\"maxCommits\":10"), "{text}");
        assert_eq!(serde_json::from_str::<ReadRequest>(&text).unwrap(), req);
        assert_eq!(serde_json::to_string(&CommitOrder::AuthorDate).unwrap(), "\"author-date\"");
        assert_eq!(serde_json::to_string(&ReadRequest::UncommittedDetails).unwrap(), "{\"kind\":\"uncommittedDetails\"}");
        assert_eq!(serde_json::to_string(&FileStatus::R).unwrap(), "\"R\"");
    }
}
