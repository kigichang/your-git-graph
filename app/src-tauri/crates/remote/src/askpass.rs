//! Credential prompts of git running on this (the remote) machine: a fetch or push from here
//! may ask for a password or a passphrase, and the person to ask sits at the app. The helper
//! is git's and ssh's askpass program itself (as the app is on the Mac: src-tauri/src/askpass.rs):
//! started by git with the socket in its environment it passes the question to the serving
//! helper, which sends it to the app as an event of the git request that asked
//! (`{"askpass": n, "prompt": ..}`) and waits for `{"op": "answer", "ask": n, "answer": ..}`.
//! When git goes away first, `{"askpassClosed": n}` tells the app to take the question down.

use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gg_backend::wire::Frame;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

const SOCKET_ENV: &str = "GG_REMOTE_ASKPASS_SOCKET";
const TOKEN_ENV: &str = "GG_REMOTE_ASKPASS_TOKEN";
/// An unanswered prompt is given up after this long (the app gives up at the same time).
const ANSWER_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize, Deserialize)]
struct Question {
    token: String,
    prompt: String,
}

#[derive(Serialize, Deserialize)]
struct Answer {
    answer: Option<String>,
}

/// Started by git or ssh as their askpass program (the socket is in the environment): ask,
/// print the answer, and say with the exit status whether there is one. `None`: not that.
pub fn helper_main() -> Option<i32> {
    let socket = std::env::var_os(SOCKET_ENV)?;
    let question = Question { token: std::env::var(TOKEN_ENV).unwrap_or_default(), prompt: std::env::args().nth(1).unwrap_or_default() };
    let ask = || -> Option<String> {
        let mut stream = std::os::unix::net::UnixStream::connect(&socket).ok()?;
        let mut line = serde_json::to_string(&question).ok()?;
        line.push('\n');
        stream.write_all(line.as_bytes()).ok()?;
        // Nothing more is written and the stream stays open: its end means "this helper is gone".
        let mut reply = String::new();
        std::io::BufReader::new(&stream).read_line(&mut reply).ok()?;
        serde_json::from_str::<Answer>(&reply).ok()?.answer
    };
    Some(match ask() {
        Some(answer) => {
            println!("{answer}");
            0
        }
        None => 1,
    })
}

pub struct Askpass {
    dir: PathBuf,
    /// token -> the git request whose environment carries it
    tokens: Mutex<HashMap<String, u64>>,
    waiting: Mutex<HashMap<u64, oneshot::Sender<Option<String>>>>,
    next: AtomicU64,
    out: mpsc::Sender<Frame>,
}

fn random_hex(bytes: usize) -> std::io::Result<String> {
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

impl Askpass {
    /// Listen on a socket in a fresh directory only this user can enter.
    pub fn start(out: mpsc::Sender<Frame>) -> std::io::Result<Arc<Askpass>> {
        let dir = std::env::temp_dir().join(format!("gg-remote-askpass-{}-{}", std::process::id(), random_hex(4)?));
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
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
        let exe = std::env::current_exe()?.display().to_string();
        Ok(vec![
            ("GIT_ASKPASS".into(), exe.clone()),
            ("SSH_ASKPASS".into(), exe),
            ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
            (SOCKET_ENV.into(), self.dir.join("s").display().to_string()),
            (TOKEN_ENV.into(), token),
        ])
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
            Ok(Ok(_)) => serde_json::from_str::<Question>(&line).ok(),
            _ => None,
        };
        let request = question.as_ref().and_then(|q| self.tokens.lock().unwrap().get(&q.token).copied());
        let answer = match (question, request) {
            (Some(question), Some(request)) => self.ask(request, question.prompt, &mut read).await,
            _ => None, // malformed or a token of no running git: never shown to anyone
        };
        let mut reply = serde_json::to_string(&Answer { answer }).unwrap_or_default();
        reply.push('\n');
        let _ = write.write_all(reply.as_bytes()).await;
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
