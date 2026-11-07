//! What an operation would make hard to find again, checked before it runs (the front end
//! shows the reasons and asks). From git's side:
//! - commits that end up on no branch, tag or remote-tracking branch (leaving a detached HEAD,
//!   resetting a branch back, force-moving a branch): recoverable only through the reflog;
//! - uncommitted changes to tracked files (a hard reset);
//! - commits a force push removes from a remote branch;
//! and, not a loss but a question: a tag pushed to a remote that lacks its commit.
//! Every check only reads.

use crate::api::{OpRequest, PushMode, Reason, ResetMode};
use crate::ops::remote::remotes_without_commit;
use crate::ops::{args, count_commits, current_branch, exec};
use crate::runtime::Runtime;

/// Leaving a detached HEAD for `target`: the commits only HEAD holds (none when HEAD is on a branch).
async fn detached(rt: &dyn Runtime, target: &str) -> Result<Vec<Reason>, String> {
    if current_branch(rt).await?.is_some() {
        return Ok(vec![]);
    }
    let count = count_commits(rt, &["HEAD", "--not", target, "--branches", "--tags", "--remotes"]).await?;
    Ok(if count > 0 { vec![Reason::DetachedCommits { count }] } else { vec![] })
}

/// Moving `branch` to `target`: how many of its commits no other ref (nor `target`) holds.
async fn moved_branch(rt: &dyn Runtime, branch: &str, target: &str) -> Result<u32, String> {
    count_commits(rt, &[&format!("refs/heads/{branch}"), "--not", target, &format!("--exclude={branch}"), "--branches", "--tags", "--remotes"]).await
}

/// The reasons `request` would lose work (empty: none).
pub async fn reasons(rt: &dyn Runtime, request: &OpRequest) -> Result<Vec<Reason>, String> {
    match request {
        OpRequest::CheckoutCommit { commit } => detached(rt, commit).await,
        OpRequest::CheckoutBranch { branch, remote_branch, .. } => detached(rt, remote_branch.as_deref().unwrap_or(branch)).await,
        OpRequest::BranchFromStash { selector, .. } => detached(rt, &format!("{selector}^")).await,
        OpRequest::CreateBranch { branch, commit, checkout, force } => {
            let mut out = Vec::new();
            if *force {
                let exists = exec(rt, args(&["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}")])).await?.exit_code == Some(0);
                if exists {
                    let count = moved_branch(rt, branch, commit).await?;
                    if count > 0 {
                        out.push(Reason::BranchMoveDropsCommits { count, branch: branch.clone() });
                    }
                }
            }
            if *checkout {
                out.extend(detached(rt, commit).await?);
            }
            Ok(out)
        }
        OpRequest::Reset { commit, mode } => {
            let mut out = match current_branch(rt).await? {
                None => detached(rt, commit).await?,
                Some(branch) => {
                    let count = moved_branch(rt, &branch, commit).await?;
                    if count > 0 { vec![Reason::ResetDropsCommits { count, branch }] } else { vec![] }
                }
            };
            if *mode == ResetMode::Hard {
                let status = exec(rt, args(&["status", "--porcelain", "--untracked-files=no"])).await?;
                let count = if status.exit_code == Some(0) { status.stdout.lines().filter(|l| !l.is_empty()).count() as u32 } else { 0 };
                if count > 0 {
                    out.push(Reason::UncommittedDiscarded { count });
                }
            }
            Ok(out)
        }
        OpRequest::Push { branch, remotes, mode, .. } => {
            if *mode == PushMode::Normal {
                return Ok(vec![]);
            }
            let mut out = Vec::new();
            for remote in remotes {
                let count = count_commits(rt, &[&format!("refs/remotes/{remote}/{branch}"), "--not", &format!("refs/heads/{branch}")]).await?;
                if count > 0 {
                    out.push(Reason::ForcePushDropsCommits { count, remote_branch: format!("{remote}/{branch}"), branch: branch.clone() });
                }
            }
            Ok(out)
        }
        OpRequest::AddTag { commit, push_to: Some(remote), .. } => {
            let missing = remotes_without_commit(rt, commit, std::slice::from_ref(remote)).await?;
            Ok(if missing.is_empty() { vec![] } else { vec![Reason::TagCommitNotOnRemote { remotes: missing }] })
        }
        OpRequest::PushTag { commit, remotes, .. } => {
            let missing = remotes_without_commit(rt, commit, remotes).await?;
            Ok(if missing.is_empty() { vec![] } else { vec![Reason::TagCommitNotOnRemote { remotes: missing }] })
        }
        _ => Ok(vec![]),
    }
}
