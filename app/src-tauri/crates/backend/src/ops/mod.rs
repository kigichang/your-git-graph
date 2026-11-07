//! The operations: each builds its git command lines and runs them through a [`Runtime`].
//! [`operate`] is the one entry point; it checks the values, asks about work that would be
//! lost (`loss`) unless the person confirmed, and runs the operation.

mod branch;
mod history;
pub mod identity;
pub mod remote;
mod stash;

use crate::api::{OpRequest, OpResult, Reason};
use crate::git::GitExecResult;
use crate::runtime::{GitOpts, Runtime};

/// What an operation reports when a step of it fails.
#[derive(Debug, Clone, PartialEq)]
pub struct Fail {
    pub message: String,
    pub step: Option<String>,
}

impl From<String> for Fail {
    fn from(message: String) -> Fail {
        Fail { message, step: None }
    }
}

pub type Outcome = Result<(), Fail>;

/// Values from the front end reach git's command line: one starting with `-` would be read as
/// an option (`--upload-pack=…`, `-oProxyCommand=…`). Refuse it instead of passing it on.
pub fn unsafe_arg<'a>(values: impl IntoIterator<Item = &'a str>) -> Result<(), String> {
    match values.into_iter().find(|v| v.starts_with('-')) {
        Some(bad) => Err(format!("Invalid argument \"{bad}\": it must not start with \"-\".")),
        None => Ok(()),
    }
}

/// The error text of a finished run, or `None` when it succeeded.
pub fn error_of(result: &GitExecResult) -> Option<String> {
    if result.exit_code == Some(0) {
        return None;
    }
    if result.timed_out {
        return Some("Git timed out.".into());
    }
    if result.cancelled {
        return Some("Cancelled.".into());
    }
    let text = result.stderr.trim();
    let text = if text.is_empty() { result.stdout.trim() } else { text };
    Some(if text.is_empty() { format!("Git exited with code {}.", result.exit_code.map_or("none".to_string(), |c| c.to_string())) } else { text.to_string() })
}

pub fn args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

pub fn flag<'a>(on: bool, parts: &'a [&'a str]) -> impl Iterator<Item = &'a str> {
    parts.iter().copied().filter(move |_| on)
}

/// Run git; the result whatever its exit code.
pub async fn exec(rt: &dyn Runtime, argv: Vec<String>) -> Result<GitExecResult, String> {
    rt.git(argv, GitOpts::default()).await
}

/// Run git; `Err(git's message)` unless it succeeded.
pub async fn run(rt: &dyn Runtime, argv: Vec<String>) -> Result<(), String> {
    match error_of(&exec(rt, argv).await?) {
        None => Ok(()),
        Some(message) => Err(message),
    }
}

/// Run git with its output streamed (fetch, push, pull).
pub async fn run_streamed(rt: &dyn Runtime, argv: Vec<String>) -> Result<(), String> {
    match error_of(&rt.git(argv, GitOpts { stream: true, ..Default::default() }).await?) {
        None => Ok(()),
        Some(message) => Err(message),
    }
}

/// The checked-out branch, or `None` when HEAD is detached.
pub async fn current_branch(rt: &dyn Runtime) -> Result<Option<String>, String> {
    let r = exec(rt, args(&["symbolic-ref", "-q", "--short", "HEAD"])).await?;
    Ok(if r.exit_code == Some(0) { Some(r.stdout.trim().to_string()) } else { None })
}

/// The hash of HEAD.
pub async fn head_hash(rt: &dyn Runtime) -> Result<String, String> {
    let r = exec(rt, args(&["rev-parse", "HEAD"])).await?;
    match error_of(&r) {
        None => Ok(r.stdout.trim().to_string()),
        Some(e) => Err(e),
    }
}

/// How many commits `git rev-list --count <args>` lists (0 when git cannot tell).
pub async fn count_commits(rt: &dyn Runtime, rest: &[&str]) -> Result<u32, String> {
    let mut argv = args(&["rev-list", "--count"]);
    argv.extend(rest.iter().map(|s| s.to_string()));
    let r = exec(rt, argv).await?;
    Ok(if r.exit_code == Some(0) { r.stdout.trim().parse().unwrap_or(0) } else { 0 })
}

/// The values of `request` that reach git's command line.
pub fn argv_values(request: &OpRequest) -> Vec<&str> {
    fn s(v: &Option<String>) -> Option<&str> {
        v.as_deref()
    }
    match request {
        OpRequest::AddRemote { name, url, push_url, .. } => [Some(name.as_str()), Some(url), s(push_url)].into_iter().flatten().collect(),
        OpRequest::EditRemote { name_old, name_new, url_new, push_url_new, .. } => [Some(name_old.as_str()), Some(name_new), s(url_new), s(push_url_new)].into_iter().flatten().collect(),
        OpRequest::DeleteRemote { name } | OpRequest::PruneRemote { name } => vec![name],
        OpRequest::Fetch { remote, .. } => s(remote).into_iter().collect(),
        OpRequest::FetchIntoLocalBranch { remote, remote_branch, local_branch, .. } => vec![remote, remote_branch, local_branch],
        OpRequest::Pull { remote, branch, .. } => vec![remote, branch],
        OpRequest::Push { branch, remotes, .. } => std::iter::once(branch.as_str()).chain(remotes.iter().map(String::as_str)).collect(),
        OpRequest::AddTag { tag, commit, push_to, .. } => [Some(tag.as_str()), Some(commit), s(push_to)].into_iter().flatten().collect(),
        OpRequest::DeleteTag { tag, delete_on_remote } => [Some(tag.as_str()), s(delete_on_remote)].into_iter().flatten().collect(),
        OpRequest::PushTag { tag, commit, remotes } => [tag.as_str(), commit].into_iter().chain(remotes.iter().map(String::as_str)).collect(),
        OpRequest::CreateBranch { branch, commit, .. } => vec![branch, commit],
        OpRequest::CheckoutBranch { branch, remote_branch, pull_afterwards } => {
            let mut v = vec![branch.as_str()];
            v.extend(s(remote_branch));
            if let Some(p) = pull_afterwards {
                v.extend([p.remote.as_str(), p.branch.as_str()]);
            }
            v
        }
        OpRequest::CheckoutCommit { commit } | OpRequest::CommitFixup { commit } | OpRequest::CommitSquash { commit } | OpRequest::DropCommit { commit } => vec![commit],
        OpRequest::DeleteBranch { branch, delete_on_remotes, .. } => std::iter::once(branch.as_str()).chain(delete_on_remotes.iter().map(String::as_str)).collect(),
        OpRequest::DeleteRemoteBranch { remote, branch } => vec![remote, branch],
        OpRequest::RenameBranch { old_name, new_name } => vec![old_name, new_name],
        OpRequest::Merge { target, .. } => vec![target],
        OpRequest::Rebase { onto, .. } => vec![onto],
        OpRequest::CherryPick { commit, .. } | OpRequest::Revert { commit, .. } | OpRequest::Reset { commit, .. } | OpRequest::EditCommitMessage { commit, .. } => vec![commit],
        OpRequest::StashApply { selector, .. } | OpRequest::StashPop { selector, .. } | OpRequest::StashDrop { selector } => vec![selector],
        OpRequest::BranchFromStash { branch, selector } => vec![branch, selector],
        OpRequest::ResetFile { commit, .. } => vec![commit],
        OpRequest::CreateArchive { reference, .. } => vec![reference],
        OpRequest::WorktreeAdd { path, branch, new_branch } => [Some(path.as_str()), s(branch), s(new_branch)].into_iter().flatten().collect(),
        OpRequest::WorktreeRemove { path, .. } => vec![path],
        // `git config` reads no options after the key: a value may start with "-".
        OpRequest::ContinueOperation { .. }
        | OpRequest::AbortOperation { .. }
        | OpRequest::UndoLastCommit
        | OpRequest::StashPush { .. }
        | OpRequest::CleanUntracked { .. }
        | OpRequest::WorktreePrune
        | OpRequest::EditUserDetails { .. }
        | OpRequest::DeleteUserDetails { .. }
        | OpRequest::SyncGlobalAuthor { .. } => vec![],
    }
}

/// Do what `request` asks. Unless `confirmed`, an operation that would lose work (or push a
/// tag whose commit the remote lacks) is not run: the reasons come back instead.
pub async fn operate(rt: &dyn Runtime, request: OpRequest, confirmed: bool) -> Result<OpResult, String> {
    if let Err(message) = unsafe_arg(argv_values(&request)) {
        return Ok(OpResult::Failed { message, step: None });
    }
    if !confirmed {
        let reasons: Vec<Reason> = crate::loss::reasons(rt, &request).await?;
        if !reasons.is_empty() {
            return Ok(OpResult::NeedsConfirmation { reasons });
        }
    }
    let outcome = match request {
        OpRequest::AddRemote { .. }
        | OpRequest::EditRemote { .. }
        | OpRequest::DeleteRemote { .. }
        | OpRequest::PruneRemote { .. }
        | OpRequest::Fetch { .. }
        | OpRequest::FetchIntoLocalBranch { .. }
        | OpRequest::Pull { .. }
        | OpRequest::Push { .. }
        | OpRequest::AddTag { .. }
        | OpRequest::DeleteTag { .. }
        | OpRequest::PushTag { .. } => remote::perform(rt, request).await,
        OpRequest::CreateBranch { .. }
        | OpRequest::CheckoutBranch { .. }
        | OpRequest::CheckoutCommit { .. }
        | OpRequest::DeleteBranch { .. }
        | OpRequest::DeleteRemoteBranch { .. }
        | OpRequest::RenameBranch { .. } => branch::perform(rt, request).await,
        OpRequest::Merge { .. }
        | OpRequest::Rebase { .. }
        | OpRequest::CherryPick { .. }
        | OpRequest::Revert { .. }
        | OpRequest::ContinueOperation { .. }
        | OpRequest::AbortOperation { .. }
        | OpRequest::Reset { .. }
        | OpRequest::UndoLastCommit
        | OpRequest::DropCommit { .. }
        | OpRequest::EditCommitMessage { .. }
        | OpRequest::CommitFixup { .. }
        | OpRequest::CommitSquash { .. } => history::perform(rt, request).await,
        OpRequest::StashPush { .. }
        | OpRequest::StashApply { .. }
        | OpRequest::StashPop { .. }
        | OpRequest::StashDrop { .. }
        | OpRequest::BranchFromStash { .. }
        | OpRequest::CleanUntracked { .. }
        | OpRequest::ResetFile { .. }
        | OpRequest::CreateArchive { .. }
        | OpRequest::WorktreeAdd { .. }
        | OpRequest::WorktreeRemove { .. }
        | OpRequest::WorktreePrune => stash::perform(rt, request).await,
        OpRequest::EditUserDetails { .. } | OpRequest::DeleteUserDetails { .. } | OpRequest::SyncGlobalAuthor { .. } => identity::perform(rt, request).await,
    };
    Ok(match outcome {
        Ok(()) => OpResult::Done,
        Err(Fail { message, step }) => OpResult::Failed { message, step },
    })
}
