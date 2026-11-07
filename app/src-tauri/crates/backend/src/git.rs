//! Running the `git` CLI: every write operation (and any read the engine declines) goes through
//! here. The engine cannot replace it - gix implements neither push nor fetch.
//!
//! [`run`] is what the app's `git_exec` and the remote helper both call.
//! Each run gets its own process group, so a timeout or a cancel also ends whatever git spawned
//! (hooks, ssh, credential helpers) instead of leaving it holding the output pipes open.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::oneshot;

/* ---------- Locating git ---------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub path: String,
    pub version: String,
}

/// The git executable, resolved once per process.
///
/// Order: `GIT_GRAPH_GIT`, then `PATH`, then the Homebrew prefixes, and `/usr/bin/git` always
/// last - even when `PATH` lists `/usr/bin` first, as the Finder's minimal `PATH` does; a user
/// with Homebrew git gets the same git as in their terminal. `/usr/bin/git` is only a stub that
/// pops the "install Command Line Tools" dialog when the tools are missing, so it is only
/// accepted when `xcode-select -p` succeeds (macOS; the remote helper on Linux takes it as it is).
pub fn locate_git() -> Result<&'static GitInfo, String> {
    static INFO: OnceLock<Result<GitInfo, String>> = OnceLock::new();
    INFO.get_or_init(resolve_git).as_ref().map_err(Clone::clone)
}

fn resolve_git() -> Result<GitInfo, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("GIT_GRAPH_GIT") {
        candidates.push(PathBuf::from(path));
    }
    let system_git = Path::new("/usr/bin/git");
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(
            std::env::split_paths(&path)
                .map(|dir| dir.join("git"))
                .filter(|git| git != system_git),
        );
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        candidates.push(Path::new(dir).join("git"));
    }
    candidates.push(system_git.to_path_buf());
    for candidate in candidates {
        if !is_executable(&candidate) {
            continue;
        }
        #[cfg(target_os = "macos")]
        if candidate == Path::new("/usr/bin/git") && !command_line_tools_installed() {
            continue;
        }
        if let Some(version) = git_version(&candidate) {
            return Ok(GitInfo { path: candidate.display().to_string(), version });
        }
    }
    if cfg!(target_os = "macos") {
        Err("Git was not found. Install the Xcode Command Line Tools (xcode-select --install) or Homebrew git, or set GIT_GRAPH_GIT.".into())
    } else {
        Err("Git was not found on the PATH (or in /usr/local/bin, /usr/bin).".into())
    }
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(target_os = "macos")]
fn command_line_tools_installed() -> bool {
    std::process::Command::new("/usr/bin/xcode-select")
        .arg("-p")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// `git version 2.56.0` → `2.56.0`.
fn git_version(path: &Path) -> Option<String> {
    let output = std::process::Command::new(path).arg("--version").stdin(Stdio::null()).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Some(text.trim().trim_start_matches("git version ").to_string())
}

/* ---------- Running git ---------- */

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GitExecRequest {
    /// The arguments after `git`.
    pub args: Vec<String>,
    /// The working directory (normally the repository root).
    pub cwd: String,
    /// Added to (and overriding) the inherited environment.
    pub env: HashMap<String, String>,
    /// Kill the run after this long; `None` = no limit.
    pub timeout_ms: Option<u64>,
    /// A caller-chosen id that `git_cancel` can target; `None` = not cancellable.
    pub id: Option<String>,
    /// Send each output chunk over the command's channel as it arrives (progress of fetch/push).
    /// Off by default: a large output would otherwise cross the IPC twice.
    pub stream: bool,
    /// Written to git's standard input, which is then closed (`--stdin` options: a list too long
    /// for the argument list); `None`: no input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdin: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitExecResult {
    /// `None` when git was killed (timeout, cancel) or died from a signal.
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub cancelled: bool,
    pub duration_ms: u64,
}

/// One chunk of live output, as the frontend's Channel receives it:
/// `{"stream": "stdout" | "stderr", "data": "..."}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "stream", content = "data", rename_all = "lowercase")]
pub enum GitOutput {
    Stdout(String),
    Stderr(String),
}

/// Run git once. When the request asks to stream, `on_output` sees every chunk as it arrives
/// (git's progress lines included); the full output is returned either way. Resolves when git exits, the timeout elapses, or `cancel`
/// fires - in the last two cases after killing git's whole process group.
pub async fn run<F>(
    git: &Path,
    request: &GitExecRequest,
    on_output: F,
    cancel: oneshot::Receiver<()>,
) -> Result<GitExecResult, String>
where
    F: Fn(GitOutput) + Send + Sync + 'static,
{
    let started = Instant::now();
    let mut command = tokio::process::Command::new(git);
    command
        .args(&request.args)
        .current_dir(&request.cwd)
        // Never prompt on a terminal nobody can see; prompts go through askpass (git_exec adds it).
        .env("GIT_TERMINAL_PROMPT", "0")
        .envs(&request.env)
        .stdin(if request.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to run git in {}: {e}", request.cwd))?;
    let pgid = child.id();
    // Written while the output is read, so that neither pipe fills up; closed when done.
    if let (Some(text), Some(mut stdin)) = (request.stdin.clone(), child.stdin.take()) {
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(text.as_bytes()).await;
        });
    }

    let stream = request.stream;
    let on_output = std::sync::Arc::new(move |chunk| {
        if stream {
            on_output(chunk);
        }
    });
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let out_cb = on_output.clone();
    let stdout_task = tokio::spawn(pump(stdout, move |s| out_cb(GitOutput::Stdout(s))));
    let err_cb = on_output.clone();
    let stderr_task = tokio::spawn(pump(stderr, move |s| err_cb(GitOutput::Stderr(s))));

    let timeout = async {
        match request.timeout_ms {
            Some(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
            None => std::future::pending().await,
        }
    };
    // A dropped sender (nobody can cancel any more) must not count as a cancel.
    let cancelled = async {
        if cancel.await.is_err() {
            std::future::pending::<()>().await;
        }
    };

    let (mut timed_out, mut was_cancelled) = (false, false);
    let status = tokio::select! {
        status = child.wait() => Some(status.map_err(|e| e.to_string())?),
        _ = timeout => { timed_out = true; None }
        _ = cancelled => { was_cancelled = true; None }
    };
    if status.is_none() {
        kill_group(pgid);
        let _ = child.kill().await;
    }

    let stdout = stdout_task.await.map_err(|e| e.to_string())?;
    let stderr = stderr_task.await.map_err(|e| e.to_string())?;
    Ok(GitExecResult {
        exit_code: status.and_then(|s| s.code()),
        stdout,
        stderr,
        timed_out,
        cancelled: was_cancelled,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// SIGKILL the run's whole process group (git and everything it spawned).
fn kill_group(pgid: Option<u32>) {
    if let Some(pgid) = pgid {
        // SAFETY: plain syscall; a group that already exited just yields ESRCH.
        unsafe {
            libc::killpg(pgid as libc::pid_t, libc::SIGKILL);
        }
    }
}

/// Read a pipe to its end, reporting each chunk as text and returning all of it. A multi-byte
/// UTF-8 character split across two reads is held back until it is complete, so streamed chunks
/// never contain a replacement character the full output would not.
async fn pump<R, F>(mut reader: R, on_chunk: F) -> String
where
    R: AsyncRead + Unpin,
    F: Fn(String),
{
    let mut all = String::new();
    let mut pending: Vec<u8> = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.extend_from_slice(&buf[..n]);
        let text = take_utf8(&mut pending);
        if !text.is_empty() {
            all.push_str(&text);
            on_chunk(text);
        }
    }
    if !pending.is_empty() {
        let rest = String::from_utf8_lossy(&pending).into_owned();
        all.push_str(&rest);
        on_chunk(rest);
    }
    all
}

/// Decode as much of `bytes` as possible, leaving only an incomplete trailing character behind.
/// Invalid sequences become U+FFFD.
fn take_utf8(bytes: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(bytes) {
            Ok(s) => {
                out.push_str(s);
                bytes.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                out.push_str(std::str::from_utf8(&bytes[..valid]).expect("validated prefix"));
                match e.error_len() {
                    // Incomplete character at the end: keep it for the next read.
                    None => {
                        bytes.drain(..valid);
                        return out;
                    }
                    Some(len) => {
                        out.push('\u{FFFD}');
                        bytes.drain(..valid + len);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn git() -> PathBuf {
        PathBuf::from(&locate_git().expect("tests need git").path)
    }

    fn req(cwd: &Path, args: &[&str]) -> GitExecRequest {
        GitExecRequest {
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: cwd.display().to_string(),
            ..Default::default()
        }
    }

    /// A cancel channel that never fires (its sender stays alive for the whole test).
    fn never() -> (oneshot::Sender<()>, oneshot::Receiver<()>) {
        oneshot::channel()
    }

    #[test]
    fn resolves_git() {
        let info = locate_git().unwrap();
        assert!(Path::new(&info.path).is_absolute());
        assert!(info.version.chars().next().unwrap().is_ascii_digit(), "{}", info.version);
    }

    #[tokio::test]
    async fn feeds_the_input_and_closes_it() {
        let dir = tempfile::tempdir().unwrap();
        let (_keep, rx) = never();
        // A large input: written while the output is read, then closed (git waits for the end).
        let mut request = req(dir.path(), &["hash-object", "--stdin"]);
        request.stdin = Some("hello\n".repeat(200_000));
        let ok = run(&git(), &request, |_| {}, rx).await.unwrap();
        assert_eq!(ok.exit_code, Some(0), "{}", ok.stderr);
        let (_keep, rx) = never();
        request.stdin = Some("hello\n".into());
        let small = run(&git(), &request, |_| {}, rx).await.unwrap();
        assert_eq!(small.stdout.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
        assert_ne!(ok.stdout, small.stdout);
    }

    #[tokio::test]
    async fn runs_in_cwd_and_reports_exit_codes() {
        let dir = tempfile::tempdir().unwrap();
        let (_keep, rx) = never();
        let fail = run(&git(), &req(dir.path(), &["rev-parse", "--show-toplevel"]), |_| {}, rx).await.unwrap();
        assert_eq!(fail.exit_code, Some(128));
        assert!(fail.stderr.contains("not a git repository"), "{}", fail.stderr);

        let (_keep, rx) = never();
        run(&git(), &req(dir.path(), &["init", "-q"]), |_| {}, rx).await.unwrap();
        let (_keep, rx) = never();
        let ok = run(&git(), &req(dir.path(), &["rev-parse", "--show-toplevel"]), |_| {}, rx).await.unwrap();
        assert_eq!(ok.exit_code, Some(0));
        let top = std::fs::canonicalize(dir.path()).unwrap();
        assert_eq!(ok.stdout.trim(), top.display().to_string());
        assert!(!ok.timed_out && !ok.cancelled);
    }

    #[tokio::test]
    async fn passes_env_and_disables_terminal_prompts() {
        let dir = tempfile::tempdir().unwrap();
        let mut request = req(dir.path(), &["-c", "alias.e=!echo \"$FOO $GIT_TERMINAL_PROMPT\"", "e"]);
        request.env.insert("FOO".into(), "bar".into());
        let (_keep, rx) = never();
        let result = run(&git(), &request, |_| {}, rx).await.unwrap();
        assert_eq!(result.stdout, "bar 0\n");
    }

    #[tokio::test]
    async fn streams_both_pipes() {
        let dir = tempfile::tempdir().unwrap();
        let chunks = Arc::new(Mutex::new(Vec::new()));
        let sink = chunks.clone();
        let mut request = req(dir.path(), &["-c", "alias.e=!printf 'out\\n'; printf 'err\\n' >&2", "e"]);
        let (_keep, rx) = never();
        let quiet = sink.clone();
        let result = run(&git(), &request, move |c| quiet.lock().unwrap().push(c), rx).await.unwrap();
        assert_eq!((result.stdout.as_str(), result.stderr.as_str()), ("out\n", "err\n"));
        assert!(chunks.lock().unwrap().is_empty(), "nothing is streamed unless asked");
        request.stream = true;
        let (_keep, rx) = never();
        let result = run(&git(), &request, move |c| sink.lock().unwrap().push(c), rx).await.unwrap();
        assert_eq!((result.stdout.as_str(), result.stderr.as_str()), ("out\n", "err\n"));
        let chunks = chunks.lock().unwrap();
        assert!(chunks.contains(&GitOutput::Stdout("out\n".into())), "{chunks:?}");
        assert!(chunks.contains(&GitOutput::Stderr("err\n".into())), "{chunks:?}");
    }

    /// `sleep` runs as a grandchild (git → sh → sleep) holding the pipes: only the group kill
    /// lets the run return promptly.
    #[tokio::test]
    async fn timeout_kills_the_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let mut request = req(dir.path(), &["-c", "alias.s=!sleep 30", "s"]);
        request.timeout_ms = Some(200);
        let (_keep, rx) = never();
        let result = run(&git(), &request, |_| {}, rx).await.unwrap();
        assert!(result.timed_out && !result.cancelled);
        assert_eq!(result.exit_code, None);
        assert!(result.duration_ms < 5000, "took {}ms", result.duration_ms);
    }

    #[tokio::test]
    async fn cancel_kills_the_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let request = req(dir.path(), &["-c", "alias.s=!sleep 30", "s"]);
        let (tx, rx) = oneshot::channel();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let _ = tx.send(());
        });
        let result = run(&git(), &request, |_| {}, rx).await.unwrap();
        assert!(result.cancelled && !result.timed_out);
        assert!(result.duration_ms < 5000, "took {}ms", result.duration_ms);
    }

    #[test]
    fn utf8_split_across_reads_is_held_back() {
        let bytes = "é".as_bytes(); // 2 bytes
        let mut pending = vec![b'a', bytes[0]];
        assert_eq!(take_utf8(&mut pending), "a");
        assert_eq!(pending, vec![bytes[0]]);
        pending.push(bytes[1]);
        assert_eq!(take_utf8(&mut pending), "é");
        assert!(pending.is_empty());

        let mut invalid = vec![b'x', 0xFF, b'y'];
        assert_eq!(take_utf8(&mut invalid), "x\u{FFFD}y");
    }
}
