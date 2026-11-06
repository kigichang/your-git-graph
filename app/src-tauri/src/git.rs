//! The `git` CLI as Tauri commands: every write operation (and any read the engine declines)
//! goes through here. The run itself is `gg_backend::git::run` - on this Mac, or by the helper
//! on the repository's machine (remote.rs).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use gg_backend::git::{locate_git, run, GitExecRequest, GitExecResult, GitInfo, GitOutput};
use tokio::sync::oneshot;

use crate::remote::{self, Remotes, Session};

/// How to cancel a run in flight.
enum Job {
    Local(oneshot::Sender<()>),
    Remote(Arc<Session>, u64),
}

/// The runs in flight, by caller-chosen id.
#[derive(Default)]
pub struct GitJobs(Mutex<HashMap<String, Job>>);

impl GitJobs {
    fn add(&self, id: &Option<String>, job: impl FnOnce() -> Job) -> Result<(), String> {
        let Some(id) = id else { return Ok(()) };
        let mut jobs = self.0.lock().unwrap();
        if jobs.contains_key(id) {
            return Err(format!("a git run with id {id} is already in flight"));
        }
        jobs.insert(id.clone(), job());
        Ok(())
    }

    fn done(&self, id: &Option<String>) {
        if let Some(id) = id {
            self.0.lock().unwrap().remove(id);
        }
    }
}

#[tauri::command]
pub async fn git_exec(
    window: tauri::Window,
    jobs: tauri::State<'_, GitJobs>,
    askpass: tauri::State<'_, Arc<crate::askpass::Askpass>>,
    remotes: tauri::State<'_, Arc<Remotes>>,
    mut request: GitExecRequest,
    on_output: tauri::ipc::Channel<GitOutput>,
) -> Result<GitExecResult, String> {
    // Before the askpass environment: it names this Mac's executable and socket, which mean
    // nothing to a git on another machine.
    if let Some(remote) = remote::parse(&request.cwd)? {
        let session = remotes.session(&remote)?;
        request.cwd = remote.path;
        let call = session.next_id();
        jobs.add(&request.id, || Job::Remote(session.clone(), call))?;
        let body = serde_json::json!({ "op": "git", "request": request });
        // The questions of the git over there (askpass events), by their number there.
        let asked: Arc<Mutex<HashMap<u64, u64>>> = Arc::default();
        let (label, prompts) = (window.label().to_string(), (*askpass).clone());
        let result = session
            .call(call, &body, |frame| match frame.kind {
                b'V' => {
                    let Ok(event) = serde_json::from_slice::<serde_json::Value>(&frame.body) else { return };
                    if let Some(ask) = event["askpass"].as_u64() {
                        remote_prompt(&session, &prompts, &label, &asked, ask, event["prompt"].as_str().unwrap_or_default().to_string());
                    } else if let Some(id) = event["askpassClosed"].as_u64().and_then(|ask| asked.lock().unwrap().remove(&ask)) {
                        prompts.close(&label, id);
                    }
                }
                kind => {
                    let text = String::from_utf8_lossy(&frame.body).into_owned();
                    let _ = on_output.send(if kind == b'S' { GitOutput::Stderr(text) } else { GitOutput::Stdout(text) });
                }
            })
            .await;
        jobs.done(&request.id);
        for (_, id) in asked.lock().unwrap().drain() {
            prompts.close(&label, id); // the run is over (or the connection lost): nothing to answer
        }
        return serde_json::from_slice(&result?).map_err(|e| e.to_string());
    }
    let git = PathBuf::from(&locate_git()?.path);
    // Credential prompts (git and ssh) come to the calling window; a caller may override.
    for (key, value) in askpass.env(window.label()).map_err(|e| format!("askpass unavailable: {e}"))? {
        request.env.entry(key).or_insert(value);
    }
    let (cancel_tx, cancel_rx) = oneshot::channel();
    jobs.add(&request.id, || Job::Local(cancel_tx))?;
    let result = run(
        &git,
        &request,
        move |chunk| {
            let _ = on_output.send(chunk);
        },
        cancel_rx,
    )
    .await;
    jobs.done(&request.id);
    result
}

/// Show a question of the git on another machine in `window` and send the answer back.
fn remote_prompt(session: &Arc<Session>, prompts: &Arc<crate::askpass::Askpass>, window: &str, asked: &Arc<Mutex<HashMap<u64, u64>>>, ask: u64, prompt: String) {
    let waiting = prompts.prompt(window, prompt);
    if let Some((id, _)) = &waiting {
        asked.lock().unwrap().insert(ask, *id);
    }
    let (session, prompts, window, asked) = (session.clone(), prompts.clone(), window.to_string(), asked.clone());
    tauri::async_runtime::spawn(async move {
        let answer = match waiting {
            None => None, // the window is gone
            Some((id, answered)) => tauri::async_runtime::spawn_blocking(move || {
                let answer = answered.recv_timeout(crate::askpass::ANSWER_TIMEOUT).ok().flatten();
                prompts.close(&window, id); // unanswered in time: take it down
                answer
            })
            .await
            .ok()
            .flatten(),
        };
        asked.lock().unwrap().remove(&ask);
        let _ = session.json(serde_json::json!({ "op": "answer", "ask": ask, "answer": answer })).await;
    });
}

/// Cancel the run with this id. `false` when no such run is in flight.
#[tauri::command]
pub fn git_cancel(jobs: tauri::State<'_, GitJobs>, id: String) -> bool {
    match jobs.0.lock().unwrap().remove(&id) {
        Some(Job::Local(cancel)) => cancel.send(()).is_ok(),
        Some(Job::Remote(session, call)) => {
            tauri::async_runtime::spawn(async move { session.cancel(call).await });
            true
        }
        None => false,
    }
}

/// The git the app runs, or why there is none.
#[tauri::command]
pub fn git_info() -> Result<GitInfo, String> {
    locate_git().cloned()
}
