//! What the two askpass programs have in common.
//!
//! Git (GIT_ASKPASS) and ssh (SSH_ASKPASS) run an "askpass" program with the prompt as its only
//! argument and read the answer from its stdout. On the Mac that program is the app's executable
//! (src-tauri/src/askpass.rs), on a remote machine the helper (crates/remote/src/askpass.rs):
//! started with a socket in its environment, either one passes the question to its serving
//! process over that socket and prints the answer.
//!
//! Here: the program's side ([`helper_main`], [`ask`]), the two lines exchanged, the environment
//! that makes git and ssh ask ([`env`]) and the private directory of the socket. Whom a server
//! asks, and how, is its own.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// An unanswered prompt is given up (answered "no answer") after this long, on both machines.
pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(300);

/// The environment variables that name a server's socket and the token of one git run. The app
/// and the remote helper each have their own pair: one never takes the other's questions.
#[derive(Clone, Copy)]
pub struct Vars {
    pub socket: &'static str,
    pub token: &'static str,
}

/// The line the program sends. The token says which git run asks: a server shows nothing for
/// one it did not hand out, so another local process cannot pose as git to harvest a password.
#[derive(Serialize, Deserialize)]
pub struct Question {
    pub token: String,
    pub prompt: String,
}

#[derive(Serialize, Deserialize)]
struct Answer {
    answer: Option<String>,
}

impl Question {
    /// The question on a line a server read; `None` when it is not one.
    pub fn parse(line: &str) -> Option<Question> {
        serde_json::from_str(line).ok()
    }

    pub fn line(&self) -> String {
        let mut line = serde_json::to_string(self).unwrap_or_default();
        line.push('\n');
        line
    }
}

/// The line a server replies with (`None`: cancelled, refused, or nobody to ask).
pub fn answer_line(answer: Option<String>) -> String {
    let mut line = serde_json::to_string(&Answer { answer }).unwrap_or_default();
    line.push('\n');
    line
}

/// Ask the server at `socket` and return its answer (`None`: cancelled, refused or unreachable).
pub fn ask(socket: &Path, token: &str, prompt: &str) -> Option<String> {
    let mut stream = UnixStream::connect(socket).ok()?;
    stream.write_all(Question { token: token.into(), prompt: prompt.into() }.line().as_bytes()).ok()?;
    // Deliberately no shutdown(Write), and nothing more is written: the server reads an
    // end-of-stream as "this program is gone" (git was killed) and takes the prompt down.
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).ok()?;
    serde_json::from_str::<Answer>(&line).ok()?.answer
}

/// When this process was started by git or ssh as their askpass program (the socket is in the
/// environment): ask, print the answer, and return the exit status that says whether there is
/// one. `None`: started for something else.
pub fn helper_main(vars: Vars) -> Option<i32> {
    let socket = std::env::var_os(vars.socket)?;
    let token = std::env::var(vars.token).unwrap_or_default();
    let prompt = std::env::args().nth(1).unwrap_or_default();
    Some(match ask(Path::new(&socket), &token, &prompt) {
        Some(answer) => {
            println!("{answer}");
            0
        }
        None => 1,
    })
}

/// The environment that makes a git run (and the ssh it starts) ask this executable, which
/// asks the server at `socket` with `token`.
pub fn env(vars: Vars, socket: &Path, token: String) -> std::io::Result<Vec<(String, String)>> {
    let exe = std::env::current_exe()?.display().to_string();
    Ok(vec![
        ("GIT_ASKPASS".into(), exe.clone()),
        ("SSH_ASKPASS".into(), exe),
        // ssh only uses SSH_ASKPASS without a terminal *and* with $DISPLAY - unless forced.
        ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
        (vars.socket.into(), socket.display().to_string()),
        (vars.token.into(), token),
    ])
}

/// A fresh directory under the temp dir that only this user can enter, for a server's socket:
/// `<prefix><pid>-<random>`.
pub fn private_dir(prefix: &str) -> std::io::Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("{prefix}{}-{}", std::process::id(), random_hex(4)?));
    std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
    Ok(dir)
}

pub fn random_hex(bytes: usize) -> std::io::Result<String> {
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}
