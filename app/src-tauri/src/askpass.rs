//! Credential prompts for git and ssh, answered in the app's window.
//!
//! Git (GIT_ASKPASS) and ssh (SSH_ASKPASS) run an "askpass" program with the prompt as its only
//! argument and read the answer from its stdout. Here that program is this very executable: when
//! it starts with `GG_ASKPASS_SOCKET` set ([`helper_main`]), it forwards the prompt over a Unix
//! socket to the running app and prints the answer - no window, no Tauri.
//!
//! The app side ([`Askpass`]) listens on a socket in a private (0700) directory and requires a
//! random token with every request, so another local process cannot pose as git to harvest a
//! password. Each window has its own token (git_exec passes the caller's), so a request is shown
//! only in the window whose git asked. Each request becomes an [`AskpassEvent::Request`] for that
//! window's frontend, which answers with [`Askpass::reply`]; if git is killed meanwhile (timeout, cancel), the helper dies with it,
//! the server sees the connection close and sends [`AskpassEvent::Close`] to drop the dialog.
//!
//! Credentials git already has (the osxkeychain credential helper is configured by both Apple's
//! and Homebrew's git) never reach this: git only asks when the keychain has nothing.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const SOCKET_ENV: &str = "GG_ASKPASS_SOCKET";
const TOKEN_ENV: &str = "GG_ASKPASS_TOKEN";
/// An unanswered prompt is given up (answered "no answer") after this long.
pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(300);
/// How often a waiting request checks whether its helper is still alive.
const POLL: Duration = Duration::from_millis(250);

#[derive(Serialize, Deserialize)]
struct WireRequest {
    token: String,
    prompt: String,
}

#[derive(Serialize, Deserialize)]
struct WireAnswer {
    answer: Option<String>,
}

/// What the frontend is told.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AskpassEvent {
    /// Show a prompt; answer it with `askpass_reply(id, answer | null)`.
    Request { id: u64, prompt: String },
    /// The prompt `id` is no longer wanted (git exited or the wait timed out): hide it.
    Close { id: u64 },
}

/// Delivers an event to the window labelled so; `false` when there is no such window (any more).
type Notify = Arc<dyn Fn(&str, AskpassEvent) -> bool + Send + Sync>;

pub struct Askpass {
    socket: PathBuf,
    /// token -> the label of the window whose git runs carry it
    tokens: Mutex<HashMap<String, String>>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Option<String>>>>,
    next_id: AtomicU64,
    notify: Notify,
}

impl Askpass {
    /// Listen in a fresh private directory under the temp dir; `notify` delivers the events.
    pub fn start(notify: Notify) -> std::io::Result<Arc<Self>> {
        remove_stale_dirs(&std::env::temp_dir());
        let dir = std::env::temp_dir().join(format!("{DIR_PREFIX}{}-{}", std::process::id(), random_hex(4)?));
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
        let socket = dir.join("s");
        let listener = UnixListener::bind(&socket)?;
        let askpass = Arc::new(Askpass {
            socket,
            tokens: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            notify,
        });
        let server = askpass.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let server = server.clone();
                std::thread::spawn(move || server.serve(stream));
            }
        });
        Ok(askpass)
    }

    /// The environment that makes git and ssh ask through this app, in the window `window`.
    pub fn env(&self, window: &str) -> std::io::Result<Vec<(String, String)>> {
        let token = {
            let mut tokens = self.tokens.lock().unwrap();
            match tokens.iter().find(|(_, label)| label.as_str() == window) {
                Some((token, _)) => token.clone(),
                None => {
                    let token = random_hex(16)?;
                    tokens.insert(token.clone(), window.to_string());
                    token
                }
            }
        };
        let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
        Ok(vec![
            ("GIT_ASKPASS".into(), exe.clone()),
            ("SSH_ASKPASS".into(), exe),
            // ssh only uses SSH_ASKPASS without a terminal *and* with $DISPLAY - unless forced.
            ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
            (SOCKET_ENV.into(), self.socket.display().to_string()),
            (TOKEN_ENV.into(), token),
        ])
    }

    /// Answer prompt `id` (`None` = cancelled). `false` when it is no longer waiting.
    pub fn reply(&self, id: u64, answer: Option<String>) -> bool {
        match self.pending.lock().unwrap().remove(&id) {
            Some(tx) => tx.send(answer).is_ok(),
            None => false,
        }
    }

    fn serve(&self, stream: UnixStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut line = String::new();
        if BufReader::new(&stream).read_line(&mut line).is_err() {
            return;
        }
        let request = serde_json::from_str::<WireRequest>(&line).ok();
        let window = request.as_ref().and_then(|r| self.tokens.lock().unwrap().get(&r.token).cloned());
        let answer = match (request, window) {
            (Some(request), Some(window)) => self.ask(&stream, &window, request.prompt),
            _ => None, // malformed or wrong token: never shown to the user
        };
        let mut reply = serde_json::to_string(&WireAnswer { answer }).unwrap_or_default();
        reply.push('\n');
        let _ = (&stream).write_all(reply.as_bytes());
    }

    /// Show `prompt` in `window`: its id and where the answer arrives (`reply`; nothing arrives
    /// once it is closed). `None` with the window gone: there is nobody to ask.
    pub fn prompt(&self, window: &str, prompt: String) -> Option<(u64, mpsc::Receiver<Option<String>>)> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if !(self.notify)(window, AskpassEvent::Request { id, prompt }) {
            self.pending.lock().unwrap().remove(&id);
            return None;
        }
        Some((id, rx))
    }

    /// The question `id` is no longer wanted: take it down.
    pub fn close(&self, window: &str, id: u64) {
        if self.pending.lock().unwrap().remove(&id).is_some() {
            (self.notify)(window, AskpassEvent::Close { id });
        }
    }

    /// Show the prompt in `window` and wait for the answer, the helper's death, or the timeout.
    fn ask(&self, stream: &UnixStream, window: &str, prompt: String) -> Option<String> {
        let (id, rx) = self.prompt(window, prompt)?;
        let started = Instant::now();
        loop {
            match rx.recv_timeout(POLL) {
                Ok(answer) => return answer,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if peer_closed(stream) || started.elapsed() > ANSWER_TIMEOUT {
                        self.close(window, id);
                        return None;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return None,
            }
        }
    }
}

/// The helper writes its request and then only reads, so a readable end-of-stream means it is gone.
fn peer_closed(stream: &UnixStream) -> bool {
    use std::os::fd::AsRawFd;
    let mut byte = 0u8;
    // SAFETY: a one-byte peek into a local buffer on a socket we own; never blocks (MSG_DONTWAIT).
    let n = unsafe {
        libc::recv(stream.as_raw_fd(), (&mut byte as *mut u8).cast(), 1, libc::MSG_PEEK | libc::MSG_DONTWAIT)
    };
    n == 0
}

const DIR_PREFIX: &str = "gg-askpass-";

/// Remove the socket directories of app processes that no longer exist. A killed app cannot
/// clean up after itself, so each start sweeps what earlier ones left behind.
fn remove_stale_dirs(temp: &Path) {
    let Ok(entries) = std::fs::read_dir(temp) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|n| n.strip_prefix(DIR_PREFIX)).and_then(|rest| rest.split('-').next()).and_then(|p| p.parse::<i32>().ok()) else {
            continue;
        };
        if pid as u32 != std::process::id() && !process_alive(pid) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn process_alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists (EPERM: it exists, owned by someone else).
    unsafe { libc::kill(pid, 0) == 0 || *libc::__error() == libc::EPERM }
}

fn random_hex(bytes: usize) -> std::io::Result<String> {
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/* ---------- The helper side (this executable, run by git or ssh) ---------- */

/// Ask the app at `socket` and return its answer (`None`: cancelled, refused or unreachable).
pub fn ask(socket: &Path, token: &str, prompt: &str) -> Option<String> {
    let mut stream = UnixStream::connect(socket).ok()?;
    let mut request = serde_json::to_string(&WireRequest { token: token.into(), prompt: prompt.into() }).ok()?;
    request.push('\n');
    stream.write_all(request.as_bytes()).ok()?;
    // Deliberately no shutdown(Write): the server reads an end-of-stream as "the helper died".
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).ok()?;
    serde_json::from_str::<WireAnswer>(&line).ok()?.answer
}

/// When this process was started as an askpass helper, do that job and return the exit code;
/// `None` for a normal app launch.
pub fn helper_main() -> Option<i32> {
    let socket = std::env::var_os(SOCKET_ENV)?;
    let token = std::env::var(TOKEN_ENV).unwrap_or_default();
    let prompt = std::env::args().nth(1).unwrap_or_default();
    Some(match ask(Path::new(&socket), &token, &prompt) {
        Some(answer) => {
            println!("{answer}");
            0
        }
        None => 1,
    })
}

/* ---------- Tauri ---------- */

#[tauri::command]
pub fn askpass_reply(askpass: tauri::State<'_, Arc<Askpass>>, id: u64, answer: Option<String>) -> bool {
    askpass.reply(id, answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A server whose "frontend" answers every request with `respond(prompt)`; also records events
    /// (with the window they went to). Windows "main" and "repo-1" exist, no other.
    fn server(respond: fn(&str) -> Option<Option<String>>) -> (Arc<Askpass>, Arc<Mutex<Vec<(String, AskpassEvent)>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let slot: Arc<Mutex<Option<Arc<Askpass>>>> = Arc::new(Mutex::new(None));
        let (log, s) = (events.clone(), slot.clone());
        let askpass = Askpass::start(Arc::new(move |window: &str, event: AskpassEvent| {
            if window != "main" && window != "repo-1" {
                return false;
            }
            log.lock().unwrap().push((window.to_string(), event.clone()));
            if let AskpassEvent::Request { id, prompt } = event {
                if let Some(answer) = respond(&prompt) {
                    let server = s.lock().unwrap().clone().unwrap();
                    std::thread::spawn(move || server.reply(id, answer));
                }
            }
            true
        }))
        .unwrap();
        *slot.lock().unwrap() = Some(askpass.clone());
        (askpass, events)
    }

    fn env_of(askpass: &Askpass, key: &str) -> String {
        env_in(askpass, "main", key)
    }
    fn env_in(askpass: &Askpass, window: &str, key: &str) -> String {
        askpass.env(window).unwrap().into_iter().find(|(k, _)| k == key).unwrap().1
    }

    #[test]
    fn answers_and_cancels_round_trip() {
        let (askpass, events) = server(|p| Some(if p.starts_with("Password") { Some("s3cret".into()) } else { None }));
        let socket = PathBuf::from(env_of(&askpass, SOCKET_ENV));
        let token = env_of(&askpass, TOKEN_ENV);
        assert_eq!(ask(&socket, &token, "Password for 'https://x': ").as_deref(), Some("s3cret"));
        assert_eq!(ask(&socket, &token, "Username for 'https://x': "), None);
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], (w, AskpassEvent::Request { prompt, .. }) if w == "main" && prompt == "Password for 'https://x': "));
    }

    #[test]
    fn a_prompt_goes_only_to_the_window_whose_git_asked() {
        let (askpass, events) = server(|_| Some(Some("ok".into())));
        let socket = PathBuf::from(env_of(&askpass, SOCKET_ENV));
        let (main, other) = (env_in(&askpass, "main", TOKEN_ENV), env_in(&askpass, "repo-1", TOKEN_ENV));
        assert_ne!(main, other, "each window has its own token");
        assert_eq!(env_in(&askpass, "repo-1", TOKEN_ENV), other, "and keeps it");
        assert_eq!(ask(&socket, &other, "Password: ").as_deref(), Some("ok"));
        assert_eq!(ask(&socket, &main, "Password: ").as_deref(), Some("ok"));
        let windows: Vec<String> = events.lock().unwrap().iter().map(|(w, _)| w.clone()).collect();
        assert_eq!(windows, ["repo-1", "main"]);
    }

    #[test]
    fn a_closed_window_gets_no_prompt_and_git_no_answer() {
        let (askpass, events) = server(|_| Some(Some("never".into())));
        let socket = PathBuf::from(env_of(&askpass, SOCKET_ENV));
        let gone = env_in(&askpass, "repo-9", TOKEN_ENV);
        let started = Instant::now();
        assert_eq!(ask(&socket, &gone, "Password: "), None);
        assert!(started.elapsed() < Duration::from_secs(2), "answered at once, not after the timeout");
        assert!(events.lock().unwrap().is_empty());
    }

    #[test]
    fn wrong_token_is_refused_without_asking() {
        let (askpass, events) = server(|_| Some(Some("leaked".into())));
        let socket = PathBuf::from(env_of(&askpass, SOCKET_ENV));
        assert_eq!(ask(&socket, "not-the-token", "Password: "), None);
        assert!(events.lock().unwrap().is_empty());
    }

    #[test]
    fn socket_directory_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let (askpass, _) = server(|_| None);
        let dir = PathBuf::from(env_of(&askpass, SOCKET_ENV)).parent().unwrap().to_path_buf();
        assert_eq!(std::fs::metadata(dir).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(env_of(&askpass, "SSH_ASKPASS_REQUIRE"), "force");
    }

    #[test]
    fn stale_directories_of_dead_processes_are_removed() {
        let temp = tempfile::tempdir().unwrap();
        let dead = temp.path().join(format!("{DIR_PREFIX}999999-ab"));
        let alive = temp.path().join(format!("{DIR_PREFIX}{}-cd", std::process::id()));
        let launchd = temp.path().join(format!("{DIR_PREFIX}1-ef")); // pid 1 exists, owned by root
        let unrelated = temp.path().join("something-else");
        for dir in [&dead, &alive, &launchd, &unrelated] {
            std::fs::create_dir(dir).unwrap();
        }
        remove_stale_dirs(temp.path());
        assert!(!dead.exists());
        assert!(alive.exists() && launchd.exists() && unrelated.exists());
    }

    #[test]
    fn a_helper_that_dies_closes_its_prompt() {
        let (askpass, events) = server(|_| None); // the "user" never answers
        let socket = PathBuf::from(env_of(&askpass, SOCKET_ENV));
        let mut stream = UnixStream::connect(&socket).unwrap();
        let request = serde_json::to_string(&WireRequest { token: env_of(&askpass, TOKEN_ENV), prompt: "Password: ".into() }).unwrap();
        stream.write_all((request + "\n").as_bytes()).unwrap();
        while events.lock().unwrap().is_empty() {
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(stream); // git killed → helper gone
        let deadline = Instant::now() + Duration::from_secs(3);
        while events.lock().unwrap().len() < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let events = events.lock().unwrap();
        let (_, AskpassEvent::Request { id, .. }) = events[0] else { panic!("{events:?}") };
        assert_eq!(events.get(1), Some(&("main".to_string(), AskpassEvent::Close { id })), "closed in the window it was shown in");
        assert!(!askpass.reply(id, Some("late".into())), "a closed prompt takes no answer");
    }
}
