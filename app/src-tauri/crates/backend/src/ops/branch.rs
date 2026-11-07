//! Branches: creating, checking out, deleting, renaming.

use super::remote::{delete_on_remote, pull};
use super::{args, flag, run, Fail, Outcome};
use crate::api::OpRequest;
use crate::runtime::Runtime;

pub async fn perform(rt: &dyn Runtime, request: OpRequest) -> Outcome {
    match request {
        OpRequest::CreateBranch { branch, commit, checkout, force } => {
            let mut v = args(&["branch"]);
            v.extend(flag(force, &["-f"]).map(String::from));
            v.extend([branch.clone(), commit]);
            run(rt, v).await?;
            if checkout {
                run(rt, args(&["checkout", &branch])).await.map_err(|e| Fail { message: e, step: Some("checkout".into()) })?;
            }
            Ok(())
        }
        OpRequest::CheckoutBranch { branch, remote_branch, pull_afterwards } => {
            let v = match &remote_branch {
                None => args(&["checkout", &branch]),
                Some(remote) => args(&["checkout", "-b", &branch, remote]),
            };
            run(rt, v).await?;
            if let Some(after) = pull_afterwards {
                pull(rt, &after.remote, &after.branch, after.no_fast_forward, after.squash).await.map_err(|e| Fail { message: e, step: Some("pull".into()) })?;
            }
            Ok(())
        }
        OpRequest::CheckoutCommit { commit } => Ok(run(rt, args(&["checkout", "--detach", &commit])).await?),
        OpRequest::DeleteBranch { branch, force, delete_on_remotes } => {
            run(rt, args(&["branch", if force { "-D" } else { "-d" }, &branch])).await?;
            for remote in &delete_on_remotes {
                delete_on_remote(rt, remote, &branch).await.map_err(|e| Fail { message: e, step: Some(remote.clone()) })?;
            }
            Ok(())
        }
        OpRequest::DeleteRemoteBranch { remote, branch } => Ok(delete_on_remote(rt, &remote, &branch).await?),
        OpRequest::RenameBranch { old_name, new_name } => Ok(run(rt, args(&["branch", "-m", &old_name, &new_name])).await?),
        other => Err(Fail::from(format!("not a branch operation: {other:?}"))),
    }
}
