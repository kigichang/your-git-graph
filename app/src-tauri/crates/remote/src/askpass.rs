//! Credential prompts of git running on this (the remote) machine: a fetch or push from here
//! may ask for a password or a passphrase, and the person to ask sits at the app. The helper
//! is git's and ssh's askpass program itself (as the app is on the Mac; the program's side is
//! gg_backend::askpass): started by git with the socket in its environment it passes the
//! question to the serving helper, which sends it to the app as an event of the git request that asked
//! (`{"askpass": n, "prompt": ..}`) and waits for `{"op": "answer", "ask": n, "answer": ..}`.
//! When git goes away first, `{"askpassClosed": n}` tells the app to take the question down.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gg_backend::askpass::{answer_line, private_dir, random_hex, Question, Vars, ANSWER_TIMEOUT};
use gg_backend::wire::Frame;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

const VARS: Vars = Vars { socket: "GG_REMOTE_ASKPASS_SOCKET", token: "GG_REMOTE_ASKPASS_TOKEN" };

/// Started by git or ssh as their askpass program: do that and return the exit status. `None`: not that.
pub fn helper_main() -> Option<i32> {
    gg_backend::askpass::helper_main(VARS)
}

pub struct Askpass {
    dir: PathBuf,
    /// token -> the git request whose environment carries it
    tokens: Mutex<HashMap<String, u64>>,
    waiting: Mutex<HashMap<u64, oneshot::Sender<Option<String>>>>,
    next: AtomicU64,
    out: mpsc::Sender<Frame>,
}

impl Askpass {
    /// Listen on a socket in a fresh directory only this user can enter.
    pub fn start(out: mpsc::Sender<Frame>) -> std::io::Result<Arc<Askpass>> {
        let dir = private_dir("gg-remote-askpass-")?;
        let listener = tokio::net::UnixListener::bind(dir.join("s"))?;
        let askpass = Arc::new(Askpass { dir, tokens: Mutex::default(), waiting: Mutex::default(), next: AtomicU64::new(1), out });
        let server = askpass.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(server.clone().serve(stream));
            }
        });
        Ok(askpass)
    }

    /// The environment that makes the git run of request `request` (and the ssh it starts) ask here.
    pub fn env(&self, request: u64) -> std::io::Result<Vec<(String, String)>> {
        let token = random_hex(16)?;
        self.tokens.lock().unwrap().insert(token.clone(), request);
        gg_backend::askpass::env(VARS, &self.dir.join("s"), token)
    }

    /// The git run of `request` ended: its token asks nothing any more.
    pub fn done(&self, request: u64) {
        self.tokens.lock().unwrap().retain(|_, r| *r != request);
    }

    /// The app's answer to question `ask` (`None`: cancelled). `false` when nobody waits for it.
    pub fn answer(&self, ask: u64, answer: Option<String>) -> bool {
        match self.waiting.lock().unwrap().remove(&ask) {
            Some(waiting) => waiting.send(answer).is_ok(),
            None => false,
        }
    }

    pub fn remove_socket(&self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }

    async fn serve(self: Arc<Self>, stream: tokio::net::UnixStream) {
        let (read, mut write) = stream.into_split();
        let mut read = tokio::io::BufReader::new(read);
        let mut line = String::new();
        let question = match tokio::time::timeout(Duration::from_secs(5), read.read_line(&mut line)).await {
            Ok(Ok(_)) => Question::parse(&line),
            _ => None,
        };
        let request = question.as_ref().and_then(|q| self.tokens.lock().unwrap().get(&q.token).copied());
        let answer = match (question, request) {
            (Some(question), Some(request)) => self.ask(request, question.prompt, &mut read).await,
            _ => None, // malformed or a token of no running git: never shown to anyone
        };
        let _ = write.write_all(answer_line(answer).as_bytes()).await;
    }

    /// Send the question to the app and wait for its answer, for the asking program to go away
    /// (its end of the stream closes), or for the timeout.
    async fn ask(&self, request: u64, prompt: String, asking: &mut (impl AsyncReadExt + Unpin)) -> Option<String> {
        let ask = self.next.fetch_add(1, Ordering::Relaxed);
        let (answer, answered) = oneshot::channel();
        self.waiting.lock().unwrap().insert(ask, answer);
        let event = serde_json::json!({ "askpass": ask, "prompt": prompt }).to_string();
        self.out.send(Frame::new(request, b'V', event)).await.ok()?;
        let mut byte = [0u8; 1];
        tokio::select! {
            answer = answered => answer.ok().flatten(),
            _ = asking.read(&mut byte) => self.give_up(request, ask).await,
            _ = tokio::time::sleep(ANSWER_TIMEOUT) => self.give_up(request, ask).await,
        }
    }

    async fn give_up(&self, request: u64, ask: u64) -> Option<String> {
        self.waiting.lock().unwrap().remove(&ask);
        let _ = self.out.send(Frame::new(request, b'V', serde_json::json!({ "askpassClosed": ask }).to_string())).await;
        None
    }
}
