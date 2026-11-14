//! The helper the app runs on a remote machine (`ssh <host> gg-remote-<id>`): it serves the
//! requests the app would otherwise answer from the local disk - the engine, the git CLI, the
//! files read outside git, the watcher - over its stdin and stdout (`gg_backend::wire`).
//!
//! It lives as long as the connection: when stdin ends (ssh is gone) every git run still in
//! flight is killed and the helper exits.

mod askpass;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gg_backend::wire::{self, Frame};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinSet;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Request {
    Engine { repo: String, request: String },
    /// A typed read (`gg_backend::api`): the same code the app runs for a local repository.
    Read { repo: String, request: gg_backend::api::ReadRequest },
    /// A typed operation (`gg_backend::ops`): its progress and the questions of its git are
    /// events (`V`) of the request; `C` cancels it.
    Op { repo: String, request: gg_backend::api::OpRequest, confirmed: bool },
    WorktreeFile { repo: String, path: String },
    ExportRepoConfig { repo: String, contents: String },
    Scan { folder: String },
    /// Stays open until cancelled; each burst of changes is an event `{"repos": [..]}`.
    Watch { roots: Vec<String> },
    /// The answer to a credential prompt (an `askpass` event of a git request); `null`: cancelled.
    Answer { ask: u64, answer: Option<String> },
}

/// What can be cancelled (operations, watches), by request id.
enum Cancel {
    Once(oneshot::Sender<()>),
    Flag(watch::Sender<bool>),
}
impl Cancel {
    fn fire(self) {
        match self {
            Cancel::Once(tx) => {
                let _ = tx.send(());
            }
            Cancel::Flag(tx) => {
                let _ = tx.send(true);
            }
        }
    }
}
type Cancels = Arc<Mutex<HashMap<u64, Cancel>>>;

#[derive(Clone)]
struct Session {
    out: mpsc::Sender<Frame>,
    cancels: Cancels,
    git: Option<PathBuf>,
    /// `None` when its socket could not be set up: git then fails instead of asking.
    askpass: Option<Arc<askpass::Askpass>>,
}

fn json<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    serde_json::to_vec(value).map_err(|e| e.to_string())
}

async fn blocking<F>(work: F) -> Result<Vec<u8>, String>
where
    F: FnOnce() -> Result<Vec<u8>, String> + Send + 'static,
{
    tokio::task::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

impl Session {
    async fn serve(self, id: u64, body: Vec<u8>) {
        let result = match serde_json::from_slice::<Request>(&body) {
            Err(e) => Err(format!("not a request: {e}")),
            Ok(request) => self.run(id, request).await,
        };
        for frame in wire::answer(id, result) {
            if self.out.send(frame).await.is_err() {
                return;
            }
        }
    }

    async fn run(&self, id: u64, request: Request) -> Result<Vec<u8>, String> {
        match request {
            Request::Engine { repo, request } => blocking(move || Ok(gg_backend::engine(&repo, &request).into_bytes())).await,
            Request::Read { repo, request } => {
                let rt = self.runtime(id, &repo, false)?;
                json(&gg_backend::api::read(&rt, request).await?)
            }
            Request::Op { repo, request, confirmed } => {
                let rt = self.runtime(id, &repo, true)?;
                let result = gg_backend::ops::operate(&rt, request, confirmed).await;
                self.cancels.lock().unwrap().remove(&id);
                if let Some(askpass) = &self.askpass {
                    askpass.done(id);
                }
                json(&result?)
            }
            Request::WorktreeFile { repo, path } => {
                blocking(move || json(&gg_backend::files::read_worktree_file(Path::new(&repo), &path)?)).await
            }
            Request::ExportRepoConfig { repo, contents } => {
                blocking(move || json(&gg_backend::repo::write_repo_config(Path::new(&repo), &contents)?.display().to_string())).await
            }
            Request::Scan { folder } => {
                blocking(move || {
                    let found = gg_backend::files::scan(Path::new(&folder), gg_backend::files::SCAN_DEPTH);
                    json(&found.iter().map(|p| p.display().to_string()).collect::<Vec<_>>())
                })
                .await
            }
            Request::Watch { roots } => self.watch(id, roots).await,
            Request::Answer { ask, answer } => json(&self.askpass.as_ref().is_some_and(|a| a.answer(ask, answer))),
        }
    }

    fn cancellable(&self, id: u64) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        self.cancels.lock().unwrap().insert(id, Cancel::Once(tx));
        rx
    }

    /// A runtime for request `id` on the repository at `repo`: git's live output and the
    /// operation's steps go back as `V` events `{"progress": …}`; with `askpass`, the questions
    /// of git and ssh too (`{"askpass", "prompt"}`), by the app's answers (`answer`).
    fn runtime(&self, id: u64, repo: &str, askpass: bool) -> Result<gg_backend::runtime::LocalRuntime, String> {
        let git = self.git.clone().ok_or("Git was not found on the remote machine.")?;
        let mut env: HashMap<String, String> = HashMap::new();
        if askpass {
            if let Some(vars) = self.askpass.as_ref().and_then(|a| a.env(id).ok()) {
                env.extend(vars);
            }
        }
        let (tx, rx) = watch::channel(false);
        self.cancels.lock().unwrap().insert(id, Cancel::Flag(tx));
        let out = self.out.clone();
        let progress = Arc::new(move |p: gg_backend::api::OpProgress| {
            let out = out.clone();
            if let Ok(event) = serde_json::to_vec(&serde_json::json!({ "progress": p })) {
                tokio::spawn(async move {
                    let _ = out.send(Frame::new(id, b'V', event)).await;
                });
            }
        });
        Ok(gg_backend::runtime::LocalRuntime::new(repo, git, env, progress, rx).remote())
    }

    async fn watch(&self, id: u64, roots: Vec<String>) -> Result<Vec<u8>, String> {
        let mut cancel = self.cancellable(id);
        let names = gg_backend::watch::named(&roots);
        let (changes, mut pending) = mpsc::unbounded_channel::<Vec<String>>();
        let watcher = gg_backend::watch::watch(self.git.clone(), roots.iter().map(PathBuf::from).collect(), false, move |changed| {
            let _ = changes.send(names(&changed));
        })
        .map_err(|e| e.to_string());
        let watcher = match watcher {
            Ok(watcher) => watcher,
            Err(e) => {
                self.cancels.lock().unwrap().remove(&id);
                return Err(e);
            }
        };
        loop {
            tokio::select! {
                _ = &mut cancel => break,
                Some(repos) = pending.recv() => {
                    let event = json(&serde_json::json!({ "repos": repos }))?;
                    if self.out.send(Frame::new(id, b'V', event)).await.is_err() {
                        break;
                    }
                }
            }
        }
        drop(watcher);
        self.cancels.lock().unwrap().remove(&id);
        Ok(b"null".to_vec())
    }
}

/// Earlier versions of the helper next to this one (`gg-remote-<id>`): each app version brings
/// its own, so the others are of no use any more.
fn remove_other_versions() {
    let Ok(me) = std::env::current_exe() else { return };
    let (Some(dir), Some(name)) = (me.parent(), me.file_name()) else { return };
    if !name.to_string_lossy().starts_with("gg-remote-") {
        return; // not deployed by the app (a development build)
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let other = entry.file_name();
        if other != name && other.to_string_lossy().starts_with("gg-remote-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn main() {
    // Started by git or ssh as their askpass program: pass the question on and exit.
    if let Some(code) = askpass::helper_main() {
        std::process::exit(code);
    }
    // sshd's non-interactive shell on a Mac has the same minimal PATH as the Finder.
    gg_backend::git::extend_path();
    tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("a runtime").block_on(serve());
}

async fn serve() {
    remove_other_versions();
    let git = gg_backend::git::locate_git().ok();
    let hello = serde_json::json!({
        "protocol": wire::PROTOCOL,
        "home": std::env::var("HOME").ok(),
        "git": git,
    });
    let mut stdout = tokio::io::stdout();
    if stdout.write_all(format!("{} {hello}\n", wire::READY).as_bytes()).await.is_err() || stdout.flush().await.is_err() {
        return;
    }

    // Every frame goes out through this one task; a slow connection makes the senders wait.
    let (out, mut frames) = mpsc::channel::<Frame>(32);
    let mut writer = tokio::spawn(async move {
        while let Some(frame) = frames.recv().await {
            if wire::write_frame(&mut stdout, &frame).await.is_err() {
                break;
            }
        }
    });
    let askpass = askpass::Askpass::start(out.clone()).ok();
    let session = Session { out, cancels: Cancels::default(), git: git.map(|g| PathBuf::from(&g.path)), askpass };
    let mut requests = JoinSet::new();
    let mut stdin = tokio::io::BufReader::new(tokio::io::stdin());
    loop {
        tokio::select! {
            frame = wire::read_frame(&mut stdin) => match frame {
                Ok(Some(Frame { id, kind: b'Q', body })) => {
                    requests.spawn(session.clone().serve(id, body));
                }
                Ok(Some(Frame { id, kind: b'C', .. })) => {
                    if let Some(cancel) = session.cancels.lock().unwrap().remove(&id) {
                        cancel.fire();
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break, // the connection is gone
            },
            _ = &mut writer => break,
            Some(_) = requests.join_next() => {}
        }
    }
    // Nobody is listening any more: end what is running (git and whatever it started).
    for (_, cancel) in session.cancels.lock().unwrap().drain() {
        cancel.fire();
    }
    let _ = tokio::time::timeout(Duration::from_secs(5), async { while requests.join_next().await.is_some() {} }).await;
    if let Some(askpass) = &session.askpass {
        askpass.remove_socket();
    }
    std::process::exit(0); // not waiting for an engine call that is still reading
}
