//! Repositories on another machine, reached over ssh the way VS Code's Remote-SSH does it:
//! nothing is mounted. The app copies a small helper (crates/remote: the engine, the git runner,
//! the file reads, the watcher) to the machine and talks to it over one `ssh` connection per
//! machine (`gg_backend::wire`); git runs there, next to the data.
//!
//! Such a repository is named `ssh://[user@]host[:port]/absolute/path` wherever a local one is
//! named by its path (the sidebar list, the state keys, the commands' `repo` arguments). The
//! commands that take a repository ask [`parse`] and forward to the machine's [`Session`].
//!
//! A connection is only ever opened by `remote_connect` (the page decides when: adding a
//! repository, showing one, a click on a faded row). Everything else fails at once with "not
//! connected" - listing ahead/behind for the whole sidebar at launch must not dial every host.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use gg_backend::wire::{self, Frame};
use serde_json::{json, Value};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

pub const SCHEME: &str = "ssh://";

/* ---------- Naming ---------- */

#[derive(Debug, Clone, PartialEq)]
pub struct Remote {
    /// `[user@]host[:port]` as written: with [`SCHEME`] the prefix of every repository there.
    pub authority: String,
    /// ssh's destination, `[user@]host`.
    pub dest: String,
    pub port: Option<u16>,
    /// The absolute path on that machine.
    pub path: String,
}

impl Remote {
    /// The name of the repository at `path` on the same machine.
    pub fn id(&self, path: &str) -> String {
        format!("{SCHEME}{}{path}", self.authority)
    }
}

/// A user or host name: letters, digits, `.`, `_`, `-`, and never a leading `-` (ssh would take
/// it for an option - the convention of gitops.js's `unsafe()`).
fn plain_name(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `None` for a local path; an error for something that starts like a remote name but is not a
/// valid one.
pub fn parse(repo: &str) -> Result<Option<Remote>, String> {
    let Some(rest) = repo.strip_prefix(SCHEME) else { return Ok(None) };
    let bad = |why: &str| Err(format!("{repo} is not an SSH repository ({why})."));
    let Some(slash) = rest.find('/') else { return bad("no path") };
    let (authority, path) = rest.split_at(slash);
    if path.contains(['\0', '\n', '\r']) {
        return bad("the path");
    }
    let (user, host_port) = match authority.rsplit_once('@') {
        Some((user, rest)) => (Some(user), rest),
        None => (None, authority),
    };
    let (host, port) = match host_port.strip_prefix('[') {
        // [IPv6]
        Some(bracketed) => match bracketed.split_once(']') {
            Some((host, "")) => (host, None),
            Some((host, port)) if port.starts_with(':') => (host, Some(&port[1..])),
            _ => return bad("the host"),
        },
        None => match host_port.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (host_port, None),
        },
    };
    let ipv6 = host_port.starts_with('[') && !host.is_empty() && host.bytes().all(|b| b.is_ascii_hexdigit() || matches!(b, b':' | b'.'));
    if !(plain_name(host) || ipv6) {
        return bad("the host");
    }
    if user.is_some_and(|u| !plain_name(u)) {
        return bad("the user");
    }
    let port = match port.map(|p| p.parse::<u16>()) {
        None => None,
        Some(Ok(port)) if port > 0 => Some(port),
        Some(_) => return bad("the port"),
    };
    let dest = match user {
        Some(user) => format!("{user}@{host}"),
        None => host.to_string(),
    };
    Ok(Some(Remote { authority: authority.to_string(), dest, port, path: path.to_string() }))
}

/// Quote for the login shell of the other machine, whatever it is: single quotes, with `'` and
/// `\` written outside them (fish reads `\` inside single quotes as an escape, sh does not).
pub fn remote_quote(s: &str) -> String {
    let mut quoted = String::from("'");
    for c in s.chars() {
        match c {
            '\'' => quoted.push_str(r"'\''"),
            '\\' => quoted.push_str(r"'\\'"),
            c => quoted.push(c),
        }
    }
    quoted.push('\'');
    quoted
}

/* ---------- The helper to copy over ---------- */

/// What the other machine runs first. Its login shell (sh, bash, zsh, fish, csh) only has to
/// pass one single-quoted word to sh: the text holds no `'`, `\`, `!` or newline. It names its
/// platform, is told which helper that needs, says whether it has it, takes it if not, and
/// becomes it. Each side waits for the other's line before sending more (`head` reads ahead).
const BOOTSTRAP: &str = concat!(
    r#"exec sh -c 'd="${XDG_CACHE_HOME:-$HOME/.cache}/your-git-graph"; echo; echo @@GG-BOOT@@ $(uname -s) $(uname -m); "#,
    r#"read id size raw || exit 96; f="$d/gg-remote-$id"; "#,
    r#"if [ -x "$f" ]; then echo @@GG-HAVE@@; else echo @@GG-SEND@@; mkdir -p "$d" && head -c "$size" | gzip -dc > "$f.$$" "#,
    r#"&& [ "$(wc -c < "$f.$$")" -eq "$raw" ] && chmod 700 "$f.$$" && mv "$f.$$" "$f" || exit 97; fi; exec "$f"'"#
);
const BOOT: &str = "@@GG-BOOT@@";
const HAVE: &str = "@@GG-HAVE@@";
const SEND: &str = "@@GG-SEND@@";

/// The helpers built by scripts/build-remote.sh: (platform, "<content id> <size>", gzip).
/// Empty for a platform this build was made without (build.rs leaves placeholders).
const HELPERS: [(&str, &str, &[u8]); 3] = [
    ("linux-x86_64", include_str!("../remote-dist/linux-x86_64.id"), include_bytes!("../remote-dist/linux-x86_64.gz")),
    ("linux-aarch64", include_str!("../remote-dist/linux-aarch64.id"), include_bytes!("../remote-dist/linux-aarch64.gz")),
    ("darwin-arm64", include_str!("../remote-dist/darwin-arm64.id"), include_bytes!("../remote-dist/darwin-arm64.gz")),
];

struct Payload {
    id: String,
    raw: usize,
    gzip: Vec<u8>,
}

fn platform(system: &str, machine: &str) -> Option<&'static str> {
    match (system, machine) {
        ("Linux", "x86_64" | "amd64") => Some("linux-x86_64"),
        ("Linux", "aarch64" | "arm64") => Some("linux-aarch64"),
        ("Darwin", "arm64") => Some("darwin-arm64"),
        _ => None,
    }
}

/// The helper for a machine answering `uname -s` / `uname -m`. `GG_REMOTE_HELPER=<executable>`
/// is sent instead, whatever the platform (development and the tests: a helper built for this
/// Mac, served through a stand-in for ssh).
fn payload(system: &str, machine: &str) -> Result<Payload, String> {
    if let Some(path) = std::env::var_os("GG_REMOTE_HELPER") {
        let raw = std::fs::read(&path).map_err(|e| format!("GG_REMOTE_HELPER: {e}"))?;
        let gzip = std::process::Command::new("/usr/bin/gzip").arg("-c").arg(&path).output().map_err(|e| e.to_string())?.stdout;
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        raw.hash(&mut hasher);
        return Ok(Payload { id: format!("dev-{:016x}", hasher.finish()), raw: raw.len(), gzip });
    }
    let name = platform(system, machine).ok_or_else(|| format!("{system} {machine} is not supported (Linux x86_64 or arm64, macOS arm64)."))?;
    let (_, id, gzip) = HELPERS.iter().find(|(platform, _, _)| *platform == name).expect("every platform has an entry");
    match id.split_whitespace().collect::<Vec<_>>()[..] {
        [id, raw] if !gzip.is_empty() => Ok(Payload { id: id.to_string(), raw: raw.parse().map_err(|_| "remote-dist is damaged")?, gzip: gzip.to_vec() }),
        _ => Err(format!("This build has no helper for {name} (app/scripts/build-remote.sh builds them).")),
    }
}

/* ---------- One connection ---------- */

fn lost(authority: &str) -> String {
    format!("The connection to {authority} was lost.")
}

pub struct Session {
    authority: String,
    /// The helper's hello: `{protocol, home, git: {path, version}}`.
    pub hello: Value,
    stdin: tokio::sync::Mutex<ChildStdin>,
    /// The requests awaiting frames; `None` once the connection is gone.
    pending: Mutex<Option<HashMap<u64, mpsc::UnboundedSender<Frame>>>>,
    next: AtomicU64,
    child: Mutex<Child>,
}

impl Session {
    pub fn next_id(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed)
    }

    async fn send(&self, frame: Frame) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        wire::write_frame(&mut *stdin, &frame).await.map_err(|_| lost(&self.authority))
    }

    /// One request (`id` from [`next_id`](Self::next_id), so the caller can cancel it): its
    /// result, with every other frame it brings (git's output, a watch's events) to `on_frame`.
    pub async fn call(&self, id: u64, body: &Value, mut on_frame: impl FnMut(Frame)) -> Result<Vec<u8>, String> {
        struct Forget<'a>(&'a Session, u64);
        impl Drop for Forget<'_> {
            fn drop(&mut self) {
                if let Some(pending) = self.0.pending.lock().unwrap().as_mut() {
                    pending.remove(&self.1);
                }
            }
        }
        let (frames, mut incoming) = mpsc::unbounded_channel();
        match self.pending.lock().unwrap().as_mut() {
            Some(pending) => pending.insert(id, frames),
            None => return Err(lost(&self.authority)),
        };
        let _forget = Forget(self, id);
        self.send(Frame::new(id, b'Q', serde_json::to_vec(body).map_err(|e| e.to_string())?)).await?;
        let mut result = Vec::new();
        while let Some(frame) = incoming.recv().await {
            match frame.kind {
                b'P' => result.extend(frame.body),
                b'R' => {
                    result.extend(frame.body);
                    return Ok(result);
                }
                b'E' => return Err(String::from_utf8_lossy(&frame.body).into_owned()),
                _ => on_frame(frame),
            }
        }
        Err(lost(&self.authority))
    }

    /// A request answered with JSON.
    pub async fn json(&self, body: Value) -> Result<Value, String> {
        let bytes = self.call(self.next_id(), &body, |_| {}).await?;
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }

    /// End request `id` (a git run, a watch); it still answers.
    pub async fn cancel(&self, id: u64) {
        let _ = self.send(Frame::new(id, b'C', Vec::new())).await;
    }
}

/// The next line of ssh's output; `None` when it ended.
async fn line(output: &mut BufReader<ChildStdout>) -> Option<String> {
    let mut bytes = Vec::new();
    match output.read_until(b'\n', &mut bytes).await {
        Ok(n) if n > 0 => Some(String::from_utf8_lossy(&bytes).trim_end().to_string()),
        _ => None,
    }
}

/// Skip to the first line starting with one of `markers` (before the first, the machine's
/// greeting and whatever its shell profile prints): which one, and the rest of that line.
async fn marker(output: &mut BufReader<ChildStdout>, markers: &[&'static str]) -> Option<(&'static str, String)> {
    while let Some(text) = line(output).await {
        for m in markers {
            if let Some(rest) = text.strip_prefix(m) {
                return Some((m, rest.trim().to_string()));
            }
        }
    }
    None
}

/// Start ssh, get the helper running on the other side, and read its hello.
async fn open(remote: &Remote, env: Vec<(String, String)>) -> Result<(Child, ChildStdin, BufReader<ChildStdout>, Value), String> {
    let program = std::env::var_os("GG_REMOTE_SSH").unwrap_or_else(|| "ssh".into());
    let mut command = Command::new(program);
    command.args(["-T", "-o", "RemoteCommand=none", "-o", "ClearAllForwardings=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=15"]);
    if let Some(port) = remote.port {
        command.args(["-p", &port.to_string()]);
    }
    let mut child = command
        .arg("--")
        .arg(&remote.dest)
        .arg(BOOTSTRAP)
        .envs(env) // password, passphrase and host key questions come to the app's dialog (askpass.rs)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Cannot run ssh: {e}"))?;
    let mut stdin = child.stdin.take().expect("piped");
    let mut output = BufReader::new(child.stdout.take().expect("piped"));
    // What ssh says (the last of it): the reason when the connection fails.
    let said = Arc::new(Mutex::new(Vec::<u8>::new()));
    let mut stderr = child.stderr.take().expect("piped");
    let sink = said.clone();
    tokio::spawn(async move {
        let mut buf = [0u8; 1024];
        while let Ok(n @ 1..) = stderr.read(&mut buf).await {
            let mut said = sink.lock().unwrap();
            said.extend_from_slice(&buf[..n]);
            let excess = said.len().saturating_sub(4096);
            said.drain(..excess);
        }
    });
    let failed = |what: &str| {
        let said = String::from_utf8_lossy(&said.lock().unwrap()).trim().to_string();
        format!("Cannot connect to {}: {}", remote.authority, if said.is_empty() { what } else { &said })
    };

    let Some((_, uname)) = marker(&mut output, &[BOOT]).await else { return Err(failed("the connection was closed.")) };
    let (system, machine) = uname.split_once(' ').unwrap_or((&uname, ""));
    let payload = payload(system, machine).map_err(|e| format!("Cannot connect to {}: {e}", remote.authority))?;
    let offer = format!("{} {} {}\n", payload.id, payload.gzip.len(), payload.raw);
    stdin.write_all(offer.as_bytes()).await.map_err(|_| failed("the connection was closed."))?;
    stdin.flush().await.map_err(|_| failed("the connection was closed."))?;
    match marker(&mut output, &[HAVE, SEND]).await {
        Some((HAVE, _)) => {}
        Some(_) => {
            stdin.write_all(&payload.gzip).await.map_err(|_| failed("the helper could not be copied."))?;
            stdin.flush().await.map_err(|_| failed("the helper could not be copied."))?;
        }
        None => return Err(failed("the connection was closed.")),
    }
    let Some((_, hello)) = marker(&mut output, &[wire::READY]).await else {
        return Err(failed("the helper could not be started there (is gzip installed, and ~/.cache writable?)."));
    };
    let hello: Value = serde_json::from_str(&hello).map_err(|e| failed(&format!("unexpected answer ({e}).")))?;
    if hello["protocol"] != wire::PROTOCOL {
        return Err(failed("the helper there speaks another protocol."));
    }
    if hello["git"].is_null() {
        return Err(failed("Git was not found there (not on the PATH of a non-interactive shell)."));
    }
    Ok((child, stdin, output, hello))
}

/* ---------- All connections ---------- */

/// Told when a connection is lost: the authority, and why.
type OnLost = Box<dyn Fn(&str, &str) + Send + Sync>;

pub struct Remotes {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// One connection attempt at a time (each may be asking for a password).
    connecting: tokio::sync::Mutex<()>,
    on_lost: OnLost,
}

impl Remotes {
    pub fn new(on_lost: OnLost) -> Arc<Remotes> {
        Arc::new(Remotes { sessions: Mutex::default(), connecting: tokio::sync::Mutex::default(), on_lost })
    }

    /// The live connection to `authority`, if there is one.
    pub fn connected(&self, authority: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(authority).cloned()
    }

    pub fn session(&self, remote: &Remote) -> Result<Arc<Session>, String> {
        self.connected(&remote.authority).ok_or_else(|| format!("Not connected to {}.", remote.authority))
    }

    /// Connect to the machine of `remote` unless connected; `env` is the askpass environment
    /// of the window asking.
    pub async fn connect(self: &Arc<Self>, remote: &Remote, env: Vec<(String, String)>) -> Result<Arc<Session>, String> {
        let _one = self.connecting.lock().await;
        if let Some(session) = self.connected(&remote.authority) {
            return Ok(session);
        }
        let (child, stdin, mut output, hello) = open(remote, env).await?;
        let session = Arc::new(Session {
            authority: remote.authority.clone(),
            hello,
            stdin: tokio::sync::Mutex::new(stdin),
            pending: Mutex::new(Some(HashMap::new())),
            next: AtomicU64::new(1),
            child: Mutex::new(child),
        });
        self.sessions.lock().unwrap().insert(remote.authority.clone(), session.clone());
        let (all, this) = (self.clone(), session.clone());
        tokio::spawn(async move {
            let why = loop {
                match wire::read_frame(&mut output).await {
                    Ok(Some(frame)) => {
                        if let Some(request) = this.pending.lock().unwrap().as_ref().and_then(|p| p.get(&frame.id)) {
                            let _ = request.send(frame);
                        }
                    }
                    Ok(None) => break lost(&this.authority),
                    Err(e) => break format!("{} ({e})", lost(&this.authority)),
                }
            };
            *this.pending.lock().unwrap() = None; // every waiting request fails
            let _ = this.child.lock().unwrap().start_kill();
            let mut sessions = all.sessions.lock().unwrap();
            if sessions.get(&this.authority).is_some_and(|s| Arc::ptr_eq(s, &this)) {
                sessions.remove(&this.authority);
            }
            drop(sessions);
            (all.on_lost)(&this.authority, &why);
        });
        Ok(session)
    }

    /// Close the connection to `authority` (its requests fail, `on_lost` is told).
    pub fn disconnect(&self, authority: &str) -> bool {
        match self.connected(authority) {
            Some(session) => session.child.lock().unwrap().start_kill().is_ok(),
            None => false,
        }
    }
}

/* ---------- Tauri ---------- */

#[derive(Clone, serde::Serialize)]
struct Disconnected {
    /// `ssh://<authority>`: the prefix of the repositories that went away.
    host: String,
    error: String,
}

pub fn start(app: &tauri::AppHandle) -> Arc<Remotes> {
    let app = app.clone();
    Remotes::new(Box::new(move |authority, error| {
        eprintln!("[remote] {error}");
        let _ = app.emit("remote-disconnected", Disconnected { host: format!("{SCHEME}{authority}"), error: error.to_string() });
    }))
}

/// Connect to the machine of the remote repository `repo` (nothing happens when connected):
/// the helper's hello. ssh's questions appear in the calling window.
#[tauri::command]
pub async fn remote_connect(
    window: tauri::Window,
    remotes: tauri::State<'_, Arc<Remotes>>,
    askpass: tauri::State<'_, Arc<crate::askpass::Askpass>>,
    repo: String,
) -> Result<Value, String> {
    let remote = parse(&repo)?.ok_or_else(|| format!("{repo} is not an SSH repository."))?;
    let env = askpass.env(window.label()).map_err(|e| format!("askpass unavailable: {e}"))?;
    Ok(remotes.connect(&remote, env).await?.hello.clone())
}

#[tauri::command]
pub fn remote_disconnect(remotes: tauri::State<'_, Arc<Remotes>>, repo: String) -> Result<bool, String> {
    let remote = parse(&repo)?.ok_or_else(|| format!("{repo} is not an SSH repository."))?;
    Ok(remotes.disconnect(&remote.authority))
}

/// A helper request about the repository (or folder) at `remote.path`, answered with JSON.
pub async fn ask(remotes: &Remotes, remote: &Remote, mut body: Value, key: &str) -> Result<Value, String> {
    body[key] = json!(remote.path);
    remotes.session(remote)?.json(body).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn names_of_remote_repositories() {
        assert_eq!(parse("/Users/me/repo"), Ok(None));
        assert_eq!(parse("relative/ssh://x/y"), Ok(None));
        let full = parse("ssh://me@build.example.com:2222/srv/git/app").unwrap().unwrap();
        assert_eq!((full.authority.as_str(), full.dest.as_str(), full.port, full.path.as_str()), ("me@build.example.com:2222", "me@build.example.com", Some(2222), "/srv/git/app"));
        assert_eq!(full.id("/srv/other"), "ssh://me@build.example.com:2222/srv/other");
        let alias = parse("ssh://nas/volume1/a b/it's").unwrap().unwrap();
        assert_eq!((alias.dest.as_str(), alias.port, alias.path.as_str()), ("nas", None, "/volume1/a b/it's"));
        let v6 = parse("ssh://git@[fe80::1]:22/r").unwrap().unwrap();
        assert_eq!((v6.dest.as_str(), v6.port, v6.authority.as_str()), ("git@fe80::1", Some(22), "git@[fe80::1]:22"));
        for bad in [
            "ssh://host", "ssh:///path", "ssh://-oProxyCommand=x/p", "ssh://-u@host/p", "ssh://u@-host/p", "ssh://a b/p", "ssh://h:0/p",
            "ssh://h:99999/p", "ssh://h:x/p", "ssh://u@@h/p", "ssh://h;id/p", "ssh://[::1/p", "ssh://[x y]/p", "ssh://h/p\nq", "ssh://$(id)/p",
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }

    /// The quoted text, read back by a shell, is the text.
    #[test]
    fn quoting_for_the_other_machines_shell() {
        let nasty = ["plain", "a b", "it's", r"back\slash", r"'\''", r"\'", "$(id) `id` ; & | > *", "", "\"q\"", r"end\"];
        for shell in ["sh", "bash", "zsh", "fish"] {
            let probe = std::process::Command::new(shell).args(["-c", "true"]).output();
            if !probe.is_ok_and(|o| o.status.success()) {
                continue; // not installed here
            }
            for text in nasty {
                let out = std::process::Command::new(shell).args(["-c", &format!("printf %s {}", remote_quote(text))]).output().unwrap();
                assert_eq!(String::from_utf8_lossy(&out.stdout), text, "{shell}: {}", remote_quote(text));
            }
        }
    }

    #[test]
    fn the_bootstrap_survives_any_login_shell_as_one_word() {
        let script = BOOTSTRAP.strip_prefix("exec sh -c '").unwrap().strip_suffix('\'').unwrap();
        assert!(!script.contains(['\'', '\\', '!', '\n']), "{script}");
    }

    #[test]
    fn helpers_by_platform() {
        assert_eq!(platform("Linux", "x86_64"), Some("linux-x86_64"));
        assert_eq!(platform("Linux", "aarch64"), Some("linux-aarch64"));
        assert_eq!(platform("Darwin", "arm64"), Some("darwin-arm64"));
        assert_eq!(platform("FreeBSD", "amd64"), None);
    }

    /* A stand-in for ssh (tests/fake-ssh.sh) runs the bootstrap on this Mac under a temporary
     * HOME, with the helper cargo built beside this test. */

    fn fixtures() -> (PathBuf, PathBuf) {
        let ssh = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fake-ssh.sh");
        // target/debug/deps/<this test> → target/debug/gg-remote
        let helper = std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().join("gg-remote");
        assert!(helper.is_file(), "{} is missing: run `cargo test --workspace` (or `cargo build -p gg-remote`)", helper.display());
        (ssh, helper)
    }

    struct Fake {
        home: tempfile::TempDir,
        remotes: Arc<Remotes>,
        lost: Arc<Mutex<Vec<String>>>,
    }

    /// One at a time: the stand-in is chosen through the process environment.
    static ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn fake() -> Fake {
        let (ssh, helper) = fixtures();
        std::env::set_var("GG_REMOTE_SSH", ssh);
        std::env::set_var("GG_REMOTE_HELPER", helper);
        let lost = Arc::new(Mutex::new(Vec::new()));
        let sink = lost.clone();
        Fake { home: tempfile::tempdir().unwrap(), remotes: Remotes::new(Box::new(move |authority, _| sink.lock().unwrap().push(authority.to_string()))), lost }
    }

    impl Fake {
        fn env(&self, noise: &str) -> Vec<(String, String)> {
            vec![("GG_FAKE_HOME".into(), self.home.path().display().to_string()), ("GG_FAKE_NOISE".into(), noise.into())]
        }
        fn helpers(&self) -> Vec<String> {
            std::fs::read_dir(self.home.path().join(".cache/your-git-graph")).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default()
        }
    }

    fn repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let git = &gg_backend::git::locate_git().unwrap().path;
        assert!(std::process::Command::new(git).args(["init", "-q"]).current_dir(&root).status().unwrap().success());
        (dir, root.display().to_string())
    }

    #[tokio::test]
    async fn connects_copies_the_helper_once_and_serves_requests() {
        let _env = ENV.lock().await;
        let fake = fake();
        let (_d, root) = repo();
        let remote = parse(&format!("ssh://tester@fake-host{root}")).unwrap().unwrap();
        assert!(ask(&fake.remotes, &remote, json!({ "op": "operationState" }), "repo").await.unwrap_err().contains("Not connected"), "nothing connects by itself");

        let session = fake.remotes.connect(&remote, fake.env("Welcome to fake-host\n@@ not a marker\n")).await.unwrap();
        assert!(session.hello["git"]["version"].is_string(), "{}", session.hello);
        assert_eq!(session.hello["home"], json!(fake.home.path().display().to_string()));
        let copied = fake.helpers();
        assert_eq!(copied.len(), 1, "{copied:?}");
        assert!(copied[0].starts_with("gg-remote-dev-"));

        let root_json = session.call(session.next_id(), &json!({ "op": "engine", "repo": root, "request": "{\"method\":\"repoRoot\",\"params\":null}" }), |_| {}).await.unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&root_json).unwrap(), json!(root));
        assert_eq!(ask(&fake.remotes, &remote, json!({ "op": "operationState" }), "repo").await.unwrap(), json!({ "type": null, "progress": null }));
        let run = session.json(json!({ "op": "git", "request": { "args": ["rev-parse", "--show-toplevel"], "cwd": root } })).await.unwrap();
        assert_eq!(run["stdout"], json!(format!("{root}\n")));

        // Connected: the same session. After a disconnect: a new one, and nothing is copied again.
        assert!(Arc::ptr_eq(&session, &fake.remotes.connect(&remote, fake.env("")).await.unwrap()));
        let modified = |f: &Fake| std::fs::metadata(f.home.path().join(".cache/your-git-graph").join(&f.helpers()[0])).unwrap().modified().unwrap();
        let before = modified(&fake);
        assert!(fake.remotes.disconnect(&remote.authority));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while fake.lost.lock().unwrap().is_empty() && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(*fake.lost.lock().unwrap(), ["tester@fake-host"]);
        assert!(fake.remotes.connected(&remote.authority).is_none());
        let again = fake.remotes.connect(&remote, fake.env("")).await.unwrap();
        assert!(!Arc::ptr_eq(&session, &again));
        assert_eq!((fake.helpers().len(), modified(&fake)), (1, before));
    }

    #[tokio::test]
    async fn a_lost_connection_fails_what_was_waiting() {
        let _env = ENV.lock().await;
        let fake = fake();
        let (_d, root) = repo();
        let remote = parse(&format!("ssh://fake-host{root}")).unwrap().unwrap();
        let session = fake.remotes.connect(&remote, fake.env("")).await.unwrap();
        let waiting = {
            let session = session.clone();
            let request = json!({ "op": "git", "request": { "args": ["-c", "alias.s=!sleep 30", "s"], "cwd": root } });
            tokio::spawn(async move { session.json(request).await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        fake.remotes.disconnect(&remote.authority);
        let failed = tokio::time::timeout(std::time::Duration::from_secs(5), waiting).await.expect("fails promptly").unwrap();
        assert!(failed.unwrap_err().contains("was lost"));
        assert!(session.json(json!({ "op": "scan", "folder": "/" })).await.unwrap_err().contains("was lost"), "a dead session answers nothing");
    }

    #[tokio::test]
    async fn a_connection_that_fails_says_why() {
        let _env = ENV.lock().await;
        let fake = fake();
        let remote = parse("ssh://fake-host/x").unwrap().unwrap();
        let mut env = fake.env("");
        env.push(("GG_FAKE_REFUSE".into(), "Permission denied (publickey).".into()));
        let error = fake.remotes.connect(&remote, env).await.err().unwrap();
        assert_eq!(error, "Cannot connect to fake-host: Permission denied (publickey).");
        assert!(fake.remotes.connected("fake-host").is_none());
    }
}
