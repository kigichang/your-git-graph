//! Merging, rebasing, cherry-picking, reverting, resetting, and rewriting commits.

use std::collections::HashMap;

use super::remote::commit_squashed;
use super::{args, error_of, exec, flag, head_hash, run, Fail, Outcome};
use crate::api::{OpRequest, ResetMode};
use crate::runtime::{GitOpts, Runtime};

/// Rewrite the checked-out branch from `commit` onwards with a rebase whose todo list is
/// written by `make_todo(commits)` (oldest first; `commits[0]` is `commit`). The todo reaches
/// git through the environment (`GG_TODO`), written by the sequence editor; so do whatever
/// else the todo's lines need (`env`), so nothing is quoted into a command line. Merge commits
/// in the range are refused: replaying them would flatten the history.
pub async fn rewrite_from(rt: &dyn Runtime, commit: &str, make_todo: impl Fn(&[String]) -> Vec<String>, env: HashMap<String, String>) -> Result<(), String> {
    if exec(rt, args(&["merge-base", "--is-ancestor", commit, "HEAD"])).await?.exit_code != Some(0) {
        return Err("The commit is not on the checked-out branch.".into());
    }
    let merges = exec(rt, args(&["rev-list", "--merges", &format!("{commit}..HEAD")])).await?;
    if !merges.stdout.trim().is_empty() {
        return Err("The branch has merge commits after this commit; rewriting it would flatten them.".into());
    }
    let parents = exec(rt, args(&["rev-list", "--parents", "-n", "1", commit])).await?;
    let is_root = parents.stdout.trim().split(' ').count() == 1;
    let range = exec(rt, args(&["rev-list", "--reverse", &if is_root { "HEAD".to_string() } else { format!("{commit}^..HEAD") }])).await?;
    if let Some(e) = error_of(&range) {
        return Err(e);
    }
    let commits: Vec<String> = range.stdout.lines().filter(|l| !l.is_empty()).map(String::from).collect();
    let todo = make_todo(&commits);
    let mut v = args(&["rebase", "-i", "--autostash"]);
    if is_root {
        v.push("--root".into());
    } else {
        v.push(format!("{commit}^"));
    }
    let mut env = env;
    env.insert("GG_TODO".into(), if todo.is_empty() { "noop".into() } else { todo.join("\n") });
    env.insert("GIT_SEQUENCE_EDITOR".into(), "sh -c 'printf \"%s\\n\" \"$GG_TODO\" > \"$1\"' gg".into());
    match error_of(&rt.git(v, GitOpts { env, ..Default::default() }).await?) {
        None => Ok(()),
        Some(e) => Err(e),
    }
}

pub async fn perform(rt: &dyn Runtime, request: OpRequest) -> Outcome {
    match request {
        OpRequest::Merge { target, no_fast_forward, squash, no_commit } => {
            let mut v = args(&["merge"]);
            v.extend(flag(squash, &["--squash"]).map(String::from));
            v.extend(flag(!squash && no_fast_forward, &["--no-ff"]).map(String::from));
            v.extend(flag(no_commit && !squash, &["--no-commit"]).map(String::from));
            v.push(target);
            run(rt, v).await?;
            if squash && !no_commit {
                commit_squashed(rt).await?;
            }
            Ok(())
        }
        OpRequest::Rebase { onto, ignore_date, autosquash, interactive } => {
            let mut options: Vec<String> = Vec::new();
            options.extend(flag(ignore_date, &["--ignore-date"]).map(String::from));
            options.extend(flag(autosquash, &["--autosquash"]).map(String::from));
            if interactive {
                // The todo editor needs a person at a terminal.
                let mut v = args(&["rebase", "-i"]);
                v.extend(options);
                v.push(onto);
                return Ok(rt.terminal(v).await?);
            }
            // --autosquash only applies to an interactive rebase; with GIT_EDITOR=true it runs unattended.
            let mut v = args(&["rebase"]);
            v.extend(flag(autosquash, &["-i"]).map(String::from));
            v.extend(options);
            v.push(onto);
            Ok(run(rt, v).await?)
        }
        OpRequest::CherryPick { commit, parent_index, record_origin, no_commit } => {
            let mut v = args(&["cherry-pick"]);
            if parent_index > 0 {
                v.extend(["-m".into(), parent_index.to_string()]);
            }
            v.extend(flag(record_origin, &["-x"]).map(String::from));
            v.extend(flag(no_commit, &["--no-commit"]).map(String::from));
            v.push(commit);
            Ok(run(rt, v).await?)
        }
        OpRequest::Revert { commit, parent_index } => {
            let mut v = args(&["revert", "--no-edit"]);
            if parent_index > 0 {
                v.extend(["-m".into(), parent_index.to_string()]);
            }
            v.push(commit);
            Ok(run(rt, v).await?)
        }
        OpRequest::ContinueOperation { operation } => Ok(run(rt, args(&[operation.git_name(), "--continue"])).await?),
        OpRequest::AbortOperation { operation } => Ok(run(rt, args(&[operation.git_name(), "--abort"])).await?),
        OpRequest::Reset { commit, mode } => {
            let mode = match mode {
                ResetMode::Soft => "--soft",
                ResetMode::Mixed => "--mixed",
                ResetMode::Hard => "--hard",
            };
            Ok(run(rt, args(&["reset", mode, &commit])).await?)
        }
        OpRequest::UndoLastCommit => Ok(run(rt, args(&["reset", "--soft", "HEAD~1"])).await?),
        OpRequest::DropCommit { commit } => Ok(rewrite_from(rt, &commit, |commits| commits.iter().skip(1).map(|c| format!("pick {c}")).collect(), HashMap::new()).await?),
        OpRequest::EditCommitMessage { commit, message, author } => {
            let author = author.map(|a| format!("{} <{}>", a.name, a.email));
            if commit == head_hash(rt).await? {
                let mut v = args(&["commit", "--amend", "--only", "--allow-empty", "-m", &message]);
                if let Some(author) = &author {
                    v.extend(["--author".into(), author.clone()]);
                }
                return Ok(run(rt, v).await?);
            }
            // An older commit: replay the branch from it, amending it right after it is picked.
            // The message and author ride in the environment, which the rebase's exec lines inherit.
            let amend = format!(
                "exec git commit --amend --only --allow-empty -m \"$GG_MESSAGE\"{}",
                if author.is_some() { " --author \"$GG_AUTHOR\"" } else { "" }
            );
            let mut env = HashMap::from([("GG_MESSAGE".to_string(), message)]);
            if let Some(author) = author {
                env.insert("GG_AUTHOR".into(), author);
            }
            Ok(rewrite_from(
                rt,
                &commit,
                |commits| {
                    commits
                        .iter()
                        .enumerate()
                        .flat_map(|(i, c)| if i == 0 { vec![format!("pick {c}"), amend.clone()] } else { vec![format!("pick {c}")] })
                        .collect()
                },
                env,
            )
            .await?)
        }
        OpRequest::CommitFixup { commit } => Ok(run(rt, args(&["commit", &format!("--fixup={commit}")])).await?),
        OpRequest::CommitSquash { commit } => Ok(run(rt, args(&["commit", &format!("--squash={commit}")])).await?),
        other => Err(Fail::from(format!("not a history operation: {other:?}"))),
    }
}
