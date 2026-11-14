//! Remotes, fetching, pulling, pushing, and tags (which reach remotes too).

use super::{args, exec, flag, run, run_streamed, Fail, Outcome};
use crate::api::{OpProgress, OpRequest, PushMode, TagKind};
use crate::runtime::Runtime;

/// `git remote set-url` takes the old URL as a regular expression: match it literally.
fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The old URL is the one the repository has, unchecked (only the new values are): `--` keeps a
/// URL starting with "-" from being read as an option.
fn set_url_args(name: &str, old: Option<&str>, new: Option<&str>, push: bool) -> Vec<String> {
    let mut v = args(&["remote", "set-url"]);
    v.extend(flag(push, &["--push"]).map(String::from));
    match (old, new) {
        (Some(old), None) => v.extend([String::from("--delete"), "--".into(), name.into(), regex_escape(old)]),
        (None, Some(new)) => v.extend([String::from("--add"), "--".into(), name.into(), new.into()]),
        (Some(old), Some(new)) => v.extend(["--".into(), name.into(), new.into(), regex_escape(old)]),
        (None, None) => {}
    }
    v
}

pub fn pull_args(remote: &str, branch: &str, no_fast_forward: bool, squash: bool) -> Vec<String> {
    let mut v = args(&["pull"]);
    v.extend(flag(squash, &["--squash"]).map(String::from));
    v.extend(flag(!squash && no_fast_forward, &["--no-ff"]).map(String::from));
    v.extend([remote.to_string(), branch.to_string()]);
    v
}

/// After `--squash` (merge or pull) git stages the result without committing: commit it with
/// the message git prepared, unless nothing was staged (already up to date).
pub async fn commit_squashed(rt: &dyn Runtime) -> Result<(), String> {
    let staged = exec(rt, args(&["diff", "--cached", "--quiet"])).await?;
    if staged.exit_code == Some(0) {
        return Ok(());
    }
    run(rt, args(&["commit", "--no-edit"])).await
}

pub async fn pull(rt: &dyn Runtime, remote: &str, branch: &str, no_fast_forward: bool, squash: bool) -> Result<(), String> {
    run_streamed(rt, pull_args(remote, branch, no_fast_forward, squash)).await?;
    if squash {
        commit_squashed(rt).await?;
    }
    Ok(())
}

/// The given remotes that have no remote-tracking branch containing `commit`.
pub async fn remotes_without_commit(rt: &dyn Runtime, commit: &str, remotes: &[String]) -> Result<Vec<String>, String> {
    let r = exec(rt, args(&["branch", "--remotes", "--contains", commit, "--format=%(refname)"])).await?;
    let refs: Vec<&str> = if r.exit_code == Some(0) { r.stdout.lines().filter(|l| !l.is_empty()).collect() } else { vec![] };
    Ok(remotes.iter().filter(|remote| !refs.iter().any(|r| r.starts_with(&format!("refs/remotes/{remote}/")))).cloned().collect())
}

/// Delete a branch on a remote. A branch already gone there only leaves the stale
/// remote-tracking branch behind: remove that instead of failing.
pub async fn delete_on_remote(rt: &dyn Runtime, remote: &str, branch: &str) -> Result<(), String> {
    match run_streamed(rt, args(&["push", remote, "--delete", branch])).await {
        Err(e) if e.to_lowercase().contains("remote ref does not exist") => run(rt, args(&["branch", "--delete", "--remotes", &format!("{remote}/{branch}")])).await,
        other => other,
    }
}

fn step(message: String, step: &str) -> Fail {
    Fail { message, step: Some(step.to_string()) }
}

pub async fn perform(rt: &dyn Runtime, request: OpRequest) -> Outcome {
    match request {
        OpRequest::AddRemote { name, url, push_url, fetch } => {
            super::run(rt, args(&["remote", "add", &name, &url])).await?;
            if let Some(push_url) = push_url {
                super::run(rt, args(&["remote", "set-url", "--push", &name, &push_url])).await.map_err(|e| step(e, "push URL"))?;
            }
            if fetch {
                run_streamed(rt, args(&["fetch", &name])).await.map_err(|e| step(e, "fetch"))?;
            }
            Ok(())
        }
        OpRequest::EditRemote { name_old, name_new, url_old, url_new, push_url_old, push_url_new } => {
            if name_old != name_new {
                super::run(rt, args(&["remote", "rename", &name_old, &name_new])).await?;
            }
            if url_old != url_new {
                super::run(rt, set_url_args(&name_new, url_old.as_deref(), url_new.as_deref(), false)).await.map_err(|e| step(e, "URL"))?;
            }
            if push_url_old != push_url_new {
                super::run(rt, set_url_args(&name_new, push_url_old.as_deref(), push_url_new.as_deref(), true)).await.map_err(|e| step(e, "push URL"))?;
            }
            Ok(())
        }
        OpRequest::DeleteRemote { name } => Ok(super::run(rt, args(&["remote", "remove", &name])).await?),
        OpRequest::PruneRemote { name } => Ok(super::run(rt, args(&["remote", "prune", &name])).await?),
        OpRequest::Fetch { remote, prune, prune_tags } => {
            let mut v = args(&["fetch"]);
            v.extend(flag(prune, &["--prune"]).map(String::from));
            v.extend(flag(prune && prune_tags, &["--prune-tags"]).map(String::from));
            v.push(remote.unwrap_or_else(|| "--all".into()));
            Ok(run_streamed(rt, v).await?)
        }
        OpRequest::FetchIntoLocalBranch { remote, remote_branch, local_branch, force } => {
            let mut v = args(&["fetch"]);
            v.extend(flag(force, &["--force"]).map(String::from));
            v.extend([remote, format!("{remote_branch}:{local_branch}")]);
            Ok(run_streamed(rt, v).await?)
        }
        OpRequest::Pull { remote, branch, no_fast_forward, squash } => Ok(pull(rt, &remote, &branch, no_fast_forward, squash).await?),
        OpRequest::Push { branch, remotes, set_upstream, mode } => {
            let total = remotes.len() as u32;
            for (i, remote) in remotes.iter().enumerate() {
                if total > 1 {
                    rt.progress(OpProgress::Step { index: i as u32, total, label: remote.clone() });
                }
                let mut v = args(&["push"]);
                v.extend(flag(set_upstream, &["--set-upstream"]).map(String::from));
                match mode {
                    PushMode::Normal => {}
                    PushMode::Force => v.push("--force".into()),
                    PushMode::ForceWithLease => v.push("--force-with-lease".into()),
                }
                v.extend([remote.clone(), branch.clone()]);
                run_streamed(rt, v).await.map_err(|e| if total > 1 { step(e, remote) } else { Fail::from(e) })?;
            }
            Ok(())
        }
        OpRequest::AddTag { tag, commit, tag_kind, message, force, push_to } => {
            let mut v = args(&["tag"]);
            v.extend(flag(force, &["-f"]).map(String::from));
            match tag_kind {
                TagKind::Annotated => v.extend(["-a".into(), tag.clone(), "-m".into(), message, commit.clone()]),
                TagKind::Lightweight => v.extend([tag.clone(), commit.clone()]),
            }
            super::run(rt, v).await?;
            if let Some(remote) = push_to {
                run_streamed(rt, args(&["push", &remote, &format!("refs/tags/{tag}")])).await.map_err(|e| step(e, "push"))?;
            }
            Ok(())
        }
        OpRequest::DeleteTag { tag, delete_on_remote } => {
            if let Some(remote) = delete_on_remote {
                run_streamed(rt, args(&["push", &remote, "--delete", &format!("refs/tags/{tag}")])).await.map_err(|e| step(e, "remote"))?;
            }
            Ok(super::run(rt, args(&["tag", "-d", &tag])).await?)
        }
        OpRequest::PushTag { tag, remotes, .. } => {
            for remote in &remotes {
                run_streamed(rt, args(&["push", remote, &format!("refs/tags/{tag}")])).await.map_err(|e| if remotes.len() > 1 { step(e, remote) } else { Fail::from(e) })?;
            }
            Ok(())
        }
        other => Err(Fail::from(format!("not a remote operation: {other:?}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_url_arguments() {
        assert_eq!(set_url_args("o", Some("a.b"), Some("c"), false), args(&["remote", "set-url", "--", "o", "c", "a\\.b"]));
        assert_eq!(set_url_args("o", Some("x"), None, true), args(&["remote", "set-url", "--push", "--delete", "--", "o", "x"]));
        assert_eq!(set_url_args("o", None, Some("y"), true), args(&["remote", "set-url", "--push", "--add", "--", "o", "y"]));
        assert_eq!(regex_escape("git@h:a/b.git"), "git@h:a/b\\.git");
    }

    #[test]
    fn pull_arguments() {
        assert_eq!(pull_args("o", "b", true, false), args(&["pull", "--no-ff", "o", "b"]));
        assert_eq!(pull_args("o", "b", true, true), args(&["pull", "--squash", "o", "b"]));
        assert_eq!(pull_args("o", "b", false, false), args(&["pull", "o", "b"]));
    }

    #[test]
    fn exit_codes_and_messages() {
        use super::super::error_of;
        let r = |code: Option<i32>, out: &str, err: &str| crate::git::GitExecResult { exit_code: code, stdout: out.into(), stderr: err.into(), timed_out: false, cancelled: false, duration_ms: 0 };
        assert_eq!(error_of(&r(Some(0), "", "")), None);
        assert_eq!(error_of(&r(Some(1), "", "bad\n")).as_deref(), Some("bad"));
        assert_eq!(error_of(&r(Some(1), "out", "")).as_deref(), Some("out"));
        assert_eq!(error_of(&r(Some(3), "", "")).as_deref(), Some("Git exited with code 3."));
    }
}
