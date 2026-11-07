//! Stashes, the working tree, archives and worktrees.

use super::{args, flag, run, Fail, Outcome};
use crate::api::OpRequest;
use crate::runtime::Runtime;

pub async fn perform(rt: &dyn Runtime, request: OpRequest) -> Outcome {
    match request {
        OpRequest::StashPush { message, include_untracked } => {
            let mut v = args(&["stash", "push"]);
            v.extend(flag(include_untracked, &["--include-untracked"]).map(String::from));
            if !message.is_empty() {
                v.extend(["-m".into(), message]);
            }
            Ok(run(rt, v).await?)
        }
        OpRequest::StashApply { selector, reinstate_index } => {
            let mut v = args(&["stash", "apply"]);
            v.extend(flag(reinstate_index, &["--index"]).map(String::from));
            v.push(selector);
            Ok(run(rt, v).await?)
        }
        OpRequest::StashPop { selector, reinstate_index } => {
            let mut v = args(&["stash", "pop"]);
            v.extend(flag(reinstate_index, &["--index"]).map(String::from));
            v.push(selector);
            Ok(run(rt, v).await?)
        }
        OpRequest::StashDrop { selector } => Ok(run(rt, args(&["stash", "drop", &selector])).await?),
        OpRequest::BranchFromStash { branch, selector } => Ok(run(rt, args(&["stash", "branch", &branch, &selector])).await?),
        OpRequest::CleanUntracked { directories } => {
            let mut v = args(&["clean", "-f"]);
            v.extend(flag(directories, &["-d"]).map(String::from));
            Ok(run(rt, v).await?)
        }
        OpRequest::ResetFile { commit, path } => Ok(run(rt, args(&["checkout", &commit, "--", &path])).await?),
        OpRequest::CreateArchive { reference, path } => {
            // git writes the archive on the repository's machine, not where the dialog pointed.
            if rt.is_remote() {
                return Err(Fail::from("Not available for a repository on another machine.".to_string()));
            }
            Ok(run(rt, args(&["archive", "-o", &path, &reference])).await?)
        }
        OpRequest::WorktreeAdd { path, branch, new_branch } => {
            let mut v = args(&["worktree", "add"]);
            if let Some(new_branch) = new_branch {
                v.extend(["-b".into(), new_branch]);
            }
            v.push(path);
            v.extend(branch);
            Ok(run(rt, v).await?)
        }
        OpRequest::WorktreeRemove { path, force } => {
            let mut v = args(&["worktree", "remove"]);
            v.extend(flag(force, &["--force"]).map(String::from));
            v.push(path);
            Ok(run(rt, v).await?)
        }
        OpRequest::WorktreePrune => Ok(run(rt, args(&["worktree", "prune"])).await?),
        other => Err(Fail::from(format!("not a stash or worktree operation: {other:?}"))),
    }
}
