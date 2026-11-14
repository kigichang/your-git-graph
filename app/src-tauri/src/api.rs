//! The typed commands the front end calls for a repository (`gg_backend::api`): reads and
//! operations. A local repository is served here through a runtime over this Mac's git; one
//! on another machine by its helper, which runs the same code (wire ops `read` and `op`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use gg_backend::api::{OpProgress, OpRequest, OpResult, ReadRequest, ReadResponse};
use gg_backend::git::{locate_git, GitExecResult};
use gg_backend::runtime::{BoxFuture, GitOpts, LocalRuntime, Runtime};
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::remote::{self, Remotes, Session};

/// How to cancel an operation in flight.
enum Job {
    Local(watch::Sender<bool>),
    Remote(Arc<Session>, u64),
}

/// The operations in flight, by the caller's id.
#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, Job>>);

impl Jobs {
    fn add(&self, id: &str, job: Job) -> Result<(), String> {
        let mut jobs = self.0.lock().unwrap();
        if jobs.contains_key(id) {
            return Err(format!("an operation with id {id} is already in flight"));
        }
        jobs.insert(id.to_string(), job);
        Ok(())
    }
    fn done(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
}

/// The repositories whose own filters the person allowed to run (`gg_backend::filters`), for as
/// long as the app runs; every window shares it.
#[derive(Default)]
pub struct AllowedFilters(Mutex<std::collections::HashSet<String>>);

impl AllowedFilters {
    fn has(&self, repo: &str) -> bool {
        self.0.lock().unwrap().contains(repo)
    }
}

/// Let the filters `repo`'s own configuration names run when its uncommitted changes are read
/// (the person asked to see them anyway), until the app quits.
#[tauri::command]
pub fn trust_filters(state: tauri::State<'_, crate::state::State>, allowed: tauri::State<'_, AllowedFilters>, repo: String) -> Result<(), String> {
    state.listed(&repo)?;
    allowed.0.lock().unwrap().insert(repo);
    Ok(())
}

/// A runtime for a local repository, in the name of `window` (git's questions go there).
fn local_runtime(repo: &str, window: &str, askpass: &crate::askpass::Askpass, filters_allowed: bool, progress: Arc<dyn Fn(OpProgress) + Send + Sync>, cancel: watch::Receiver<bool>) -> Result<LocalRuntime, String> {
    let git = PathBuf::from(&locate_git()?.path);
    let env: HashMap<String, String> = askpass.env(window).map_err(|e| format!("askpass unavailable: {e}"))?.into_iter().collect();
    let cwd = repo.to_string();
    Ok(LocalRuntime::new(repo, git, env, progress, cancel)
        .allow_filters(filters_allowed)
        .with_terminal(Arc::new(move |args| crate::system::terminal(cwd.clone(), Some(args)))))
}

type OpenTerminal = Arc<dyn Fn(Vec<String>) -> Result<(), String> + Send + Sync>;

/// Where an interactive rebase of a repository on another machine runs: its todo editor needs a
/// person at a terminal, which the helper over there cannot open. So the operation runs here, as
/// for a local repository (the same checks and command line), and its terminal is one on this Mac
/// that runs it over `ssh -t` (`system::terminal`). Nothing else is run here.
struct RemoteTerminal {
    repo: String,
    open: OpenTerminal,
}

impl RemoteTerminal {
    fn new(repo: &str) -> RemoteTerminal {
        let cwd = repo.to_string();
        RemoteTerminal { repo: repo.to_string(), open: Arc::new(move |args| crate::system::terminal(cwd.clone(), Some(args))) }
    }

    /// Whether `request` is one to run this way.
    fn wanted(request: &OpRequest) -> bool {
        matches!(request, OpRequest::Rebase { interactive: true, .. })
    }
}

impl Runtime for RemoteTerminal {
    fn repo(&self) -> &str {
        &self.repo
    }
    fn git(&self, _args: Vec<String>, _opts: GitOpts) -> BoxFuture<'_, Result<GitExecResult, String>> {
        Box::pin(async { Err("Git runs on the repository's machine.".to_string()) })
    }
    fn engine(&self, _method: &str, _params: Value) -> Result<Value, String> {
        Err("The engine runs on the repository's machine.".to_string())
    }
    fn terminal(&self, args: Vec<String>) -> BoxFuture<'_, Result<(), String>> {
        let opened = (self.open)(args);
        Box::pin(async move { opened })
    }
    fn is_remote(&self) -> bool {
        true
    }
    fn cancelled(&self) -> bool {
        false
    }
    fn progress(&self, _progress: OpProgress) {}
}

#[tauri::command]
pub async fn repo_read(
    window: tauri::Window,
    state: tauri::State<'_, crate::state::State>,
    askpass: tauri::State<'_, Arc<crate::askpass::Askpass>>,
    remotes: tauri::State<'_, Arc<Remotes>>,
    allowed: tauri::State<'_, AllowedFilters>,
    repo: String,
    request: ReadRequest,
) -> Result<ReadResponse, String> {
    state.listed(&repo)?;
    let filters_allowed = allowed.has(&repo);
    if let Some(remote) = remote::parse(&repo)? {
        let answer = remote::ask(&remotes, &remote, json!({ "op": "read", "request": request, "filtersAllowed": filters_allowed }), "repo").await?;
        return serde_json::from_value(answer).map_err(|e| e.to_string());
    }
    let (_tx, rx) = watch::channel(false);
    let rt = local_runtime(&repo, window.label(), &askpass, filters_allowed, Arc::new(|_| {}), rx)?;
    gg_backend::api::read(&rt, request).await
}

/// Do `request` to `repo`; `id` lets `repo_op_cancel` stop it; `on_progress` sees git's
/// output and the operation's steps. Unless `confirmed`, work that would be lost comes back
/// as `NeedsConfirmation` instead of being done.
#[tauri::command]
pub async fn repo_op(
    window: tauri::Window,
    state: tauri::State<'_, crate::state::State>,
    jobs: tauri::State<'_, Jobs>,
    askpass: tauri::State<'_, Arc<crate::askpass::Askpass>>,
    remotes: tauri::State<'_, Arc<Remotes>>,
    allowed: tauri::State<'_, AllowedFilters>,
    repo: String,
    request: OpRequest,
    confirmed: bool,
    id: String,
    on_progress: tauri::ipc::Channel<OpProgress>,
) -> Result<OpResult, String> {
    state.listed(&repo)?;
    if let Some(remote) = remote::parse(&repo)? {
        if RemoteTerminal::wanted(&request) {
            return gg_backend::ops::operate(&RemoteTerminal::new(&repo), request, confirmed).await;
        }
        let session = remotes.session(&remote)?;
        let call = session.next_id();
        jobs.add(&id, Job::Remote(session.clone(), call))?;
        let body = json!({ "op": "op", "repo": remote.path, "request": request, "confirmed": confirmed, "filtersAllowed": allowed.has(&repo) });
        // The questions of the git over there (askpass events), by their number there.
        let asked: Arc<Mutex<HashMap<u64, u64>>> = Arc::default();
        let (label, prompts) = (window.label().to_string(), (*askpass).clone());
        let result = session
            .call(call, &body, |frame| {
                if frame.kind != b'V' {
                    return;
                }
                let Ok(event) = serde_json::from_slice::<serde_json::Value>(&frame.body) else { return };
                if let Some(ask) = event["askpass"].as_u64() {
                    crate::git::remote_prompt(&session, &prompts, &label, &asked, ask, event["prompt"].as_str().unwrap_or_default().to_string());
                } else if let Some(id) = event["askpassClosed"].as_u64().and_then(|ask| asked.lock().unwrap().remove(&ask)) {
                    prompts.close(&label, id);
                } else if let Ok(progress) = serde_json::from_value::<OpProgress>(event["progress"].clone()) {
                    let _ = on_progress.send(progress);
                }
            })
            .await;
        jobs.done(&id);
        for (_, id) in asked.lock().unwrap().drain() {
            prompts.close(&label, id); // the run is over (or the connection lost): nothing to answer
        }
        return serde_json::from_slice(&result?).map_err(|e| e.to_string());
    }
    let (tx, rx) = watch::channel(false);
    jobs.add(&id, Job::Local(tx))?;
    let progress = Arc::new(move |p| {
        let _ = on_progress.send(p);
    });
    let result = match local_runtime(&repo, window.label(), &askpass, allowed.has(&repo), progress, rx) {
        Ok(rt) => gg_backend::ops::operate(&rt, request, confirmed).await,
        Err(e) => Err(e),
    };
    jobs.done(&id);
    result
}

/// Stop the operation with this id: its git is killed and nothing more of it runs. `false`
/// when no such operation is in flight.
#[tauri::command]
pub fn repo_op_cancel(jobs: tauri::State<'_, Jobs>, id: String) -> bool {
    match jobs.0.lock().unwrap().remove(&id) {
        Some(Job::Local(cancel)) => cancel.send(true).is_ok(),
        Some(Job::Remote(session, call)) => {
            tauri::async_runtime::spawn(async move { session.cancel(call).await });
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An interactive rebase of a repository on another machine: the terminal on this Mac gets
    /// the same `git rebase -i …` as for a local one; the values are checked first.
    #[tokio::test]
    async fn an_interactive_rebase_over_ssh_opens_a_terminal_here() {
        let opened: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
        let seen = opened.clone();
        let rt = RemoteTerminal {
            repo: "ssh://me@host/srv/repo".into(),
            open: Arc::new(move |args| {
                seen.lock().unwrap().push(args);
                Ok(())
            }),
        };
        let rebase = |onto: &str, interactive| OpRequest::Rebase { onto: onto.into(), ignore_date: true, autosquash: false, interactive };
        assert!(RemoteTerminal::wanted(&rebase("main", true)));
        assert!(!RemoteTerminal::wanted(&rebase("main", false)), "the helper runs the others");
        assert_eq!(gg_backend::ops::operate(&rt, rebase("main", true), false).await, Ok(OpResult::Done));
        assert_eq!(*opened.lock().unwrap(), vec![vec!["rebase".to_string(), "-i".into(), "--ignore-date".into(), "main".into()]]);
        assert!(matches!(gg_backend::ops::operate(&rt, rebase("--exec=x", true), false).await, Ok(OpResult::Failed { .. })));
        assert_eq!(opened.lock().unwrap().len(), 1, "an unsafe value opens nothing");
    }
}
