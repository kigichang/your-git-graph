//! Where an operation runs: the repository, its git, the engine, and the way back to whoever
//! asked (progress, cancellation). The app builds one for a local repository; the remote
//! helper builds one on its machine; the operations (`ops`, `loss`, `reads`) only see the trait.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{oneshot, watch};

use crate::api::{engine_call, OpProgress};
use crate::git::{self, GitExecRequest, GitExecResult, GitOutput};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What one git run may add to the usual: more environment, live output, input.
#[derive(Debug, Clone, Default)]
pub struct GitOpts {
    pub env: HashMap<String, String>,
    /// Report the output as it arrives (fetch, push: their progress).
    pub stream: bool,
    /// git's standard input (for its `--stdin` options).
    pub stdin: Option<String>,
}

pub trait Runtime: Send + Sync {
    /// The repository's root, as git sees it on this machine.
    fn repo(&self) -> &str;

    /// Run `git <args>` in the repository. Never prompts, never opens an editor.
    fn git(&self, args: Vec<String>, opts: GitOpts) -> BoxFuture<'_, Result<GitExecResult, String>>;

    /// One engine call (reads).
    fn engine(&self, method: &str, params: Value) -> Result<Value, String> {
        engine_call(self.repo(), method, params)
    }

    /// Open a terminal running `git <args>` in the repository, for what needs a person at one
    /// (an interactive rebase). Only the app can.
    fn terminal(&self, _args: Vec<String>) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Err("A terminal cannot be opened here.".to_string()) })
    }

    /// Whether the repository is on another machine than the person (archives are written
    /// where git runs, which is then not where the save dialog pointed).
    fn is_remote(&self) -> bool {
        false
    }

    /// Whether the person gave up on the operation: the next git run is not started.
    fn cancelled(&self) -> bool;

    /// Tell whoever asked how the operation is going (git's live output goes this way too).
    fn progress(&self, progress: OpProgress);
}

/// A runtime over the git on this machine: the app's, for a local repository, and the remote
/// helper's, on the repository's machine.
pub struct LocalRuntime {
    repo: String,
    git: PathBuf,
    /// Added to every run (the askpass variables, say).
    base_env: HashMap<String, String>,
    progress: Arc<dyn Fn(OpProgress) + Send + Sync>,
    cancel: watch::Receiver<bool>,
    terminal: Option<Arc<dyn Fn(Vec<String>) -> Result<(), String> + Send + Sync>>,
    remote: bool,
}

impl LocalRuntime {
    /// `cancel` turns true when the operation is to stop; `progress` sees git's live output.
    pub fn new(repo: &str, git: PathBuf, base_env: HashMap<String, String>, progress: Arc<dyn Fn(OpProgress) + Send + Sync>, cancel: watch::Receiver<bool>) -> LocalRuntime {
        LocalRuntime { repo: repo.to_string(), git, base_env, progress, cancel, terminal: None, remote: false }
    }

    pub fn with_terminal(mut self, terminal: Arc<dyn Fn(Vec<String>) -> Result<(), String> + Send + Sync>) -> LocalRuntime {
        self.terminal = Some(terminal);
        self
    }

    /// Mark the repository as one on another machine than the person.
    pub fn remote(mut self) -> LocalRuntime {
        self.remote = true;
        self
    }

}

impl Runtime for LocalRuntime {
    fn repo(&self) -> &str {
        &self.repo
    }

    fn git(&self, args: Vec<String>, opts: GitOpts) -> BoxFuture<'_, Result<GitExecResult, String>> {
        Box::pin(async move {
            if self.cancelled() {
                return Err("Cancelled.".into());
            }
            let mut env = self.base_env.clone();
            // No editor can be shown: commands that would open one take their default text.
            // No optional locks: a `git diff` that rewrote the index would wake the file watcher.
            env.insert("GIT_EDITOR".into(), "true".into());
            env.insert("GIT_OPTIONAL_LOCKS".into(), "0".into());
            env.extend(opts.env);
            let request = GitExecRequest { args, cwd: self.repo.clone(), env, timeout_ms: None, stream: opts.stream, stdin: opts.stdin };
            // git::run takes a one-shot cancel: fire it when the operation's flag turns true.
            let (tx, rx) = oneshot::channel();
            let mut flag = self.cancel.clone();
            let watcher = tokio::spawn(async move {
                loop {
                    if *flag.borrow() {
                        let _ = tx.send(());
                        return;
                    }
                    if flag.changed().await.is_err() {
                        return; // nobody can cancel any more
                    }
                }
            });
            let progress = self.progress.clone();
            let result = git::run(
                &self.git,
                &request,
                move |chunk| {
                    progress(match chunk {
                        GitOutput::Stdout(text) => OpProgress::Output { stderr: false, text },
                        GitOutput::Stderr(text) => OpProgress::Output { stderr: true, text },
                    })
                },
                rx,
            )
            .await;
            watcher.abort();
            result
        })
    }

    fn terminal(&self, args: Vec<String>) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            match &self.terminal {
                Some(open) => open(args),
                None => Err("A terminal cannot be opened here.".to_string()),
            }
        })
    }

    fn is_remote(&self) -> bool {
        self.remote
    }

    fn cancelled(&self) -> bool {
        *self.cancel.borrow()
    }

    fn progress(&self, progress: OpProgress) {
        (self.progress)(progress);
    }
}
