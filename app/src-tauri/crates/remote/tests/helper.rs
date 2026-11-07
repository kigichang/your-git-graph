//! The helper as the app drives it: started as a child process, frames over its pipes.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use gg_backend::wire::{self, Frame};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    hello: Value,
    next: u64,
}

impl Helper {
    async fn start() -> Helper {
        let mut child = Command::new(env!("CARGO_BIN_EXE_gg-remote"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).await.unwrap();
        let hello = serde_json::from_str(line.strip_prefix(wire::READY).expect("the ready line").trim()).unwrap();
        Helper { child, stdin, stdout, hello, next: 1 }
    }

    async fn send(&mut self, kind: u8, id: u64, body: Vec<u8>) {
        wire::write_frame(self.stdin.as_mut().unwrap(), &Frame::new(id, kind, body)).await.unwrap();
    }

    /// Send a request; its id.
    async fn ask(&mut self, request: Value) -> u64 {
        let id = self.next;
        self.next += 1;
        self.send(b'Q', id, serde_json::to_vec(&request).unwrap()).await;
        id
    }

    async fn frame(&mut self) -> Frame {
        tokio::time::timeout(Duration::from_secs(20), wire::read_frame(&mut self.stdout)).await.expect("a frame in time").unwrap().expect("a frame")
    }

    /// Read until request `id` is answered: its result (the parts joined) or error, and every
    /// other frame seen on the way, in order.
    async fn answer(&mut self, id: u64) -> (Result<Vec<u8>, String>, Vec<Frame>) {
        let (mut parts, mut others) = (Vec::new(), Vec::new());
        loop {
            let frame = self.frame().await;
            match (frame.id == id, frame.kind) {
                (true, b'P') => parts.extend(frame.body),
                (true, b'R') => {
                    parts.extend(frame.body);
                    return (Ok(parts), others);
                }
                (true, b'E') => return (Err(String::from_utf8(frame.body).unwrap()), others),
                _ => others.push(frame),
            }
        }
    }

    async fn result(&mut self, request: Value) -> Value {
        let id = self.ask(request).await;
        serde_json::from_slice(&self.answer(id).await.0.expect("a result")).unwrap()
    }
}

fn git(dir: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .envs([("GIT_AUTHOR_NAME", "t"), ("GIT_AUTHOR_EMAIL", "t@t"), ("GIT_COMMITTER_NAME", "t"), ("GIT_COMMITTER_EMAIL", "t@t")])
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?}");
}

/// A repository with one commit.
fn repo() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["commit", "-q", "--allow-empty", "-m", "one"]);
    (dir, root)
}

fn git_request(root: &Path, args: &[&str]) -> Value {
    json!({ "op": "git", "request": { "args": args, "cwd": root } })
}

#[tokio::test]
async fn says_hello_and_answers_the_engine_and_the_file_requests() {
    let (_d, root) = repo();
    let mut helper = Helper::start().await;
    assert_eq!(helper.hello["protocol"], wire::PROTOCOL);
    assert!(helper.hello["git"]["version"].is_string(), "{}", helper.hello);
    assert!(helper.hello["home"].is_string());

    std::fs::create_dir(root.join("sub")).unwrap();
    let inside = root.join("sub").display().to_string();
    let found = helper.result(json!({ "op": "engine", "repo": inside, "request": "{\"method\":\"repoRoot\",\"params\":null}" })).await;
    assert_eq!(found, json!(root.display().to_string()));
    let failed = helper.result(json!({ "op": "engine", "repo": "/nonexistent", "request": "{\"method\":\"open\",\"params\":null}" })).await;
    assert!(failed["error"].is_string(), "engine failures stay in-band: {failed}");

    assert_eq!(helper.result(json!({ "op": "operationState", "repo": root })).await, json!({ "type": null, "progress": null }));
    std::fs::create_dir_all(root.join("nested/.git")).unwrap();
    assert_eq!(helper.result(json!({ "op": "scan", "folder": root })).await, json!([root.join("nested").display().to_string()]));
    let written = helper.result(json!({ "op": "exportRepoConfig", "repo": root, "contents": "{\"a\":1}" })).await;
    assert_eq!(written, json!(root.join(".your-git-graph.json").display().to_string()));
    let read = helper.result(json!({ "op": "worktreeFile", "repo": root, "path": ".your-git-graph.json" })).await;
    assert_eq!(read["text"], "{\"a\":1}");

    let id = helper.ask(json!({ "op": "worktreeFile", "repo": root, "path": "../outside" })).await;
    assert!(helper.answer(id).await.0.unwrap_err().contains("not a path inside"));
    let id = helper.ask(json!({ "op": "nonsense" })).await;
    assert!(helper.answer(id).await.0.unwrap_err().contains("not a request"));
}

#[tokio::test]
async fn runs_git_with_its_environment_streaming_when_asked() {
    let (_d, root) = repo();
    let mut helper = Helper::start().await;
    let top = helper.result(git_request(&root, &["rev-parse", "--show-toplevel"])).await;
    assert_eq!((top["exitCode"].as_i64(), top["stdout"].as_str()), (Some(0), Some(format!("{}\n", root.display()).as_str())));

    let mut request = git_request(&root, &["-c", "alias.e=!printf \"$FOO\\n\"; printf 'err\\n' >&2", "e"]);
    request["request"]["env"] = json!({ "FOO": "bar" });
    let id = helper.ask(request.clone()).await;
    let (result, others) = helper.answer(id).await;
    let result: Value = serde_json::from_slice(&result.unwrap()).unwrap();
    assert_eq!((result["stdout"].as_str(), result["stderr"].as_str()), (Some("bar\n"), Some("err\n")));
    assert!(others.is_empty(), "nothing is streamed unless asked: {others:?}");

    request["request"]["stream"] = json!(true);
    let id = helper.ask(request).await;
    let (_, others) = helper.answer(id).await;
    assert!(others.contains(&Frame::new(id, b'O', "bar\n")) && others.contains(&Frame::new(id, b'S', "err\n")), "{others:?}");
}

#[tokio::test]
async fn a_git_run_ends_by_timeout_or_cancel() {
    let (_d, root) = repo();
    let mut helper = Helper::start().await;
    let mut request = git_request(&root, &["-c", "alias.s=!sleep 30", "s"]);
    request["request"]["timeoutMs"] = json!(200);
    let timed = helper.result(request).await;
    assert_eq!((timed["timedOut"].as_bool(), timed["exitCode"].is_null()), (Some(true), true));

    let started = Instant::now();
    let id = helper.ask(git_request(&root, &["-c", "alias.s=!sleep 30", "s"])).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    helper.send(b'C', id, Vec::new()).await;
    let cancelled: Value = serde_json::from_slice(&helper.answer(id).await.0.unwrap()).unwrap();
    assert_eq!(cancelled["cancelled"], true);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn a_large_file_arrives_whole_without_holding_up_a_small_request() {
    use base64::Engine;
    let (_d, root) = repo();
    let bytes: Vec<u8> = (0..5_000_000u32).map(|i| (i.wrapping_mul(2654435761) >> 24) as u8).collect();
    std::fs::write(root.join("big.bin"), &bytes).unwrap();
    let mut helper = Helper::start().await;
    let big = helper.ask(json!({ "op": "worktreeFile", "repo": root, "path": "big.bin" })).await;
    let small = helper.ask(json!({ "op": "operationState", "repo": root })).await;
    let (result, others) = helper.answer(big).await;
    let file: Value = serde_json::from_slice(&result.unwrap()).unwrap();
    let got = base64::engine::general_purpose::STANDARD.decode(file["base64"].as_str().unwrap()).unwrap();
    assert!(got == bytes, "the file's bytes");
    assert!(others.contains(&Frame::new(small, b'R', "{\"type\":null,\"progress\":null}")), "answered while the file was on its way");
}

#[tokio::test]
async fn a_watch_reports_changes_of_the_git_directory_until_cancelled() {
    let (_d, root) = repo();
    let mut helper = Helper::start().await;
    let id = helper.ask(json!({ "op": "watch", "roots": [root] })).await;
    tokio::time::sleep(Duration::from_millis(700)).await; // the watcher needs a moment to start
    std::fs::write(root.join("untracked.txt"), "x").unwrap(); // the work tree is not watched
    git(&root, &["branch", "side"]);
    let event = helper.frame().await;
    assert_eq!((event.id, event.kind), (id, b'V'));
    assert_eq!(serde_json::from_slice::<Value>(&event.body).unwrap(), json!({ "repos": [root] }));
    helper.send(b'C', id, Vec::new()).await;
    assert_eq!(helper.answer(id).await.0.unwrap(), b"null");
}

#[tokio::test]
async fn the_end_of_the_connection_ends_the_helper_and_its_git_runs() {
    let (dir, root) = repo();
    let pid_file = dir.path().join("pid");
    let mut helper = Helper::start().await;
    let alias = format!("alias.s=!echo $$ > '{}'; exec sleep 30", pid_file.display());
    helper.ask(git_request(&root, &["-c", &alias, "s"])).await;
    let deadline = Instant::now() + Duration::from_secs(5);
    while !pid_file.exists() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let pid = std::fs::read_to_string(&pid_file).unwrap().trim().to_string();
    let alive = || std::process::Command::new("kill").args(["-0", &pid]).stderr(Stdio::null()).status().unwrap().success();
    assert!(alive(), "sleep is running");

    drop(helper.stdin.take()); // ssh went away
    let status = tokio::time::timeout(Duration::from_secs(8), helper.child.wait()).await.expect("the helper exits").unwrap();
    assert!(status.success());
    assert!(!alive(), "what git started is gone too");
}

#[tokio::test]
async fn git_asks_the_app_for_credentials() {
    let (_d, root) = repo();
    let mut helper = Helper::start().await;
    let ask = git_request(&root, &["-c", "alias.ap=!\"$GIT_ASKPASS\" 'Password for the test: '", "ap"]);
    let event = |frame: &Frame, id: u64| {
        assert_eq!((frame.id, frame.kind), (id, b'V'));
        serde_json::from_slice::<Value>(&frame.body).unwrap()
    };

    // Answered: git gets the answer.
    let id = helper.ask(ask.clone()).await;
    let question = event(&helper.frame().await, id);
    assert_eq!(question["prompt"], "Password for the test: ");
    let answering = helper.ask(json!({ "op": "answer", "ask": question["askpass"], "answer": "s3cret" })).await;
    let (result, others) = helper.answer(id).await;
    let result: Value = serde_json::from_slice(&result.unwrap()).unwrap();
    assert_eq!((result["exitCode"].as_i64(), result["stdout"].as_str()), (Some(0), Some("s3cret\n")));
    assert!(others.contains(&Frame::new(answering, b'R', "true")), "{others:?}");

    // Cancelled: git's askpass fails.
    let id = helper.ask(ask.clone()).await;
    let question = event(&helper.frame().await, id);
    helper.ask(json!({ "op": "answer", "ask": question["askpass"], "answer": null })).await;
    let result: Value = serde_json::from_slice(&helper.answer(id).await.0.unwrap()).unwrap();
    assert_ne!(result["exitCode"].as_i64(), Some(0));

    // git goes away first (a timeout): the question is taken back, and a late answer is nobody's.
    let mut timed = ask;
    timed["request"]["timeoutMs"] = json!(500);
    let id = helper.ask(timed).await;
    let question = event(&helper.frame().await, id);
    let (result, others) = helper.answer(id).await;
    assert_eq!(serde_json::from_slice::<Value>(&result.unwrap()).unwrap()["timedOut"], true);
    let closed = match others.first() {
        Some(frame) => event(frame, id),
        None => event(&helper.frame().await, id), // it may also arrive just after the result
    };
    assert_eq!(closed["askpassClosed"], question["askpass"]);
    assert_eq!(helper.result(json!({ "op": "answer", "ask": question["askpass"], "answer": "late" })).await, json!(false));
}

/// The typed read and operation ops: the same code as the app's, over the pipe; an
/// operation's git output comes back as progress events, and a question as a result.
#[tokio::test]
async fn typed_reads_and_operations_over_the_pipe() {
    let (_dir, root) = repo();
    let mut helper = Helper::start().await;
    let info = helper.result(json!({ "op": "read", "repo": root, "request": { "kind": "repoInfo", "showRemoteBranches": true, "showRemoteHeads": false, "hideRemotes": [], "showStashes": true } })).await;
    assert_eq!(info["kind"], "repoInfo");
    assert_eq!(info["branches"], json!(["main"]));
    let state = helper.result(json!({ "op": "read", "repo": root, "request": { "kind": "operationState" } })).await;
    assert_eq!(state, json!({ "kind": "operationState", "operation": null, "progress": null, "conflictedFiles": [] }));

    let done = helper.result(json!({ "op": "op", "repo": root, "confirmed": false, "request": { "kind": "createBranch", "branch": "b", "commit": "HEAD", "checkout": false, "force": false } })).await;
    assert_eq!(done, json!({ "kind": "done" }));
    // The branch gets a commit of its own; moving it away then asks first.
    git(&root, &["checkout", "-q", "b"]);
    git(&root, &["commit", "-q", "--allow-empty", "-m", "only on b"]);
    git(&root, &["checkout", "-q", "main"]);
    let asked = helper.result(json!({ "op": "op", "repo": root, "confirmed": false, "request": { "kind": "createBranch", "branch": "b", "commit": "main", "checkout": false, "force": true } })).await;
    assert_eq!(asked, json!({ "kind": "needsConfirmation", "reasons": [{ "kind": "branchMoveDropsCommits", "count": 1, "branch": "b" }] }));
    let done = helper.result(json!({ "op": "op", "repo": root, "confirmed": true, "request": { "kind": "createBranch", "branch": "b", "commit": "main", "checkout": false, "force": true } })).await;
    assert_eq!(done, json!({ "kind": "done" }));

    // A fetch from itself streams what git says, as events of the request.
    let id = helper.ask(json!({ "op": "op", "repo": root, "confirmed": false, "request": { "kind": "addRemote", "name": "self", "url": root, "pushUrl": null, "fetch": true } })).await;
    let (result, others) = helper.answer(id).await;
    assert_eq!(serde_json::from_slice::<Value>(&result.unwrap()).unwrap(), json!({ "kind": "done" }));
    let progress: Vec<Value> = others.iter().filter(|f| f.id == id && f.kind == b'V').map(|f| serde_json::from_slice(&f.body).unwrap()).collect();
    assert!(progress.iter().any(|p| p["progress"]["kind"] == "output" && p["progress"]["text"].as_str().unwrap_or_default().contains("From ")), "{progress:?}");

    // Archives stay on the person's machine: refused over here.
    let refused = helper.result(json!({ "op": "op", "repo": root, "confirmed": false, "request": { "kind": "createArchive", "reference": "main", "path": root.join("a.zip") } })).await;
    assert_eq!(refused["kind"], "failed");
    assert!(refused["message"].as_str().unwrap().contains("another machine"));
    drop(helper.stdin.take());
    helper.child.wait().await.unwrap();
}
