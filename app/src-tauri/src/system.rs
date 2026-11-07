//! macOS integrations the VS Code host got from the editor: the clipboard, opening URLs and
//! files with their default app, and Terminal. Also network volumes: mounting a share, and
//! telling which share a folder is on.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

fn run(command: &mut Command) -> Result<(), String> {
    let output = command.stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Keep the process out of App Nap for the rest of its life. Under GG_SELFTEST and GG_PREVIEW
/// the window usually sits behind the terminal; once macOS naps the app, WebKit stops the
/// page's timers (the self-test stalls after its last diff window closes) and drops its drawing
/// (a screenshot shows an empty window).
pub fn no_app_nap(reason: &str) {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(NSActivityOptions::UserInitiatedAllowingIdleSystemSleep, &NSString::from_str(reason));
    std::mem::forget(activity); // ended only when the process ends
}

#[tauri::command]
pub fn clipboard_write(text: String) -> Result<(), String> {
    let mut child = Command::new("/usr/bin/pbcopy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child.stdin.take().expect("piped").write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err("pbcopy failed".into()) }
}

/// Open a web/mail URL in the default browser / mail app. Other schemes are refused: the URL
/// comes from repository content (issue links, remote URLs).
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let allowed = ["https://", "http://", "mailto:"].iter().any(|p| url.to_ascii_lowercase().starts_with(p));
    if !allowed {
        return Err(format!("Refusing to open {url}: only http(s) and mailto links are opened."));
    }
    run(Command::new("/usr/bin/open").arg(&url))
}

/// Open an existing file with its default app; with `text`, with the default text editor
/// (the settings file and the session log: `.json`/`.log` may belong to anything).
#[tauri::command]
pub fn open_path(path: String, text: Option<bool>) -> Result<(), String> {
    if crate::remote::parse(&path)?.is_some() {
        return Err("Files of a repository on another machine cannot be opened on this Mac.".into());
    }
    if !Path::new(&path).exists() {
        return Err(format!("{path} does not exist."));
    }
    let mut open = Command::new("/usr/bin/open");
    if text == Some(true) {
        open.arg("-t");
    }
    run(open.arg("--").arg(&path))
}

/// Quote for a POSIX shell: everything inside single quotes, `'` as `'\''`.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Quote for an AppleScript string literal.
fn applescript_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// What Terminal runs for a repository on another machine: ssh with a terminal, there `cd` to
/// it and run `git <args>`, or (no args) its login shell.
fn remote_line(remote: &crate::remote::Remote, git_args: Option<&[String]>) -> String {
    use crate::remote::remote_quote;
    let mut there = format!("cd {} && ", remote_quote(&remote.path));
    match git_args {
        // `exec $SHELL -l` reads the same in sh, bash, zsh and fish.
        None => there.push_str("exec $SHELL -l"),
        Some(args) => {
            there.push_str("git");
            for arg in args {
                there.push(' ');
                there.push_str(&remote_quote(arg));
            }
        }
    }
    let port = remote.port.map(|p| format!(" -p {p}")).unwrap_or_default();
    format!("ssh -t{port} -- {} {}", shell_quote(&remote.dest), shell_quote(&there))
}

fn terminal_do(line: &str) -> Result<(), String> {
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script {}\nend tell",
        applescript_quote(line)
    );
    run(Command::new("/usr/bin/osascript").args(["-e", &script]))
}

/// Open Terminal in `cwd`; with `args`, also run `git <args>` there (interactive rebase needs a
/// real terminal for its editor). For a repository on another machine: over ssh.
#[tauri::command]
pub fn open_terminal(cwd: String, git_args: Option<Vec<String>>) -> Result<(), String> {
    if let Some(remote) = crate::remote::parse(&cwd)? {
        return terminal_do(&remote_line(&remote, git_args.as_deref()));
    }
    if !Path::new(&cwd).is_dir() {
        return Err(format!("{cwd} is not a directory."));
    }
    let Some(args) = git_args else {
        return run(Command::new("/usr/bin/open").args(["-a", "Terminal", "--"]).arg(&cwd));
    };
    let mut line = format!("cd {} && git", shell_quote(&cwd));
    for arg in &args {
        line.push(' ');
        line.push_str(&shell_quote(arg));
    }
    terminal_do(&line)
}

/* ---------- Network volumes ---------- */

/// What is wrong with `url` as a share to mount, if anything: `smb://[user@]server/share`.
fn invalid_share(url: &str) -> Option<&'static str> {
    let Some(rest) = url.strip_prefix("smb://") else { return Some("The address of a share starts with smb://") };
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Some("The address of a share contains no spaces (write %20).");
    }
    match rest.split_once('/') {
        Some((server, share)) if !server.is_empty() && !share.is_empty() => None,
        _ => Some("The address of a share is smb://server/share"),
    }
}

/// Mount the share at `url` as the Finder's Connect to Server does (macOS asks for the name and
/// password itself and keeps them in the keychain; a share already mounted is just found):
/// where it is mounted.
#[tauri::command]
pub async fn mount_volume(url: String) -> Result<String, String> {
    if let Some(problem) = invalid_share(&url) {
        return Err(format!("{problem}."));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let script = format!("POSIX path of (mount volume {})", applescript_quote(&url));
        let output = Command::new("/usr/bin/osascript").args(["-e", &script]).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            // "execution error: <what the Finder says> (-<number>)"
            let said = String::from_utf8_lossy(&output.stderr);
            let said = said.trim().rsplit_once("execution error: ").map_or(said.trim(), |(_, message)| message);
            return Err(format!("Cannot connect to {url}: {said}"));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().trim_end_matches('/').to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn c_text(chars: &[libc::c_char]) -> String {
    let bytes: Vec<u8> = chars.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The share `path` is on, as an address `mount_volume` takes, when it is on an SMB volume.
fn share_of(path: &Path) -> Option<String> {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: statfs fills the struct it is given for a NUL-terminated path.
    let mut info: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c_path.as_ptr(), &mut info) } != 0 {
        return None;
    }
    // smbfs names what it mounted "//[user@]server/share".
    (c_text(&info.f_fstypename) == "smbfs").then(|| format!("smb:{}", c_text(&info.f_mntfromname)))
}

/// The address of the share the folder `path` is on, `null` for a local folder (or one that is
/// not there): what to mount to get it back when its volume is gone.
#[tauri::command]
pub async fn network_volume(path: String) -> Option<String> {
    if !matches!(crate::remote::parse(&path), Ok(None)) {
        return None;
    }
    tauri::async_runtime::spawn_blocking(move || share_of(Path::new(&path))).await.ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares() {
        for fine in ["smb://nas/projects", "smb://me@nas.local/projects/sub", "smb://me@10.0.0.2:1445/My%20Share"] {
            assert_eq!(invalid_share(fine), None, "{fine}");
        }
        for bad in ["nas/projects", "afp://nas/x", "smb://", "smb://nas", "smb://nas/", "smb:///share", "smb://nas/my share", "smb://nas/x\ny"] {
            assert!(invalid_share(bad).is_some(), "{bad}");
        }
        assert_eq!(share_of(Path::new("/")), None, "a local volume");
        assert_eq!(share_of(Path::new("/nonexistent/gg")), None);
    }

    /// The line Terminal gets, with ssh replaced by a program printing its arguments: what the
    /// other machine's shell is handed is exactly `cd <path> && git <args>`.
    #[test]
    fn the_terminal_line_for_a_remote_repository() {
        let remote = crate::remote::parse("ssh://me@host:2200/srv/it's here").unwrap().unwrap();
        let args = ["rebase".to_string(), "-i".to_string(), "a b".to_string()];
        let line = remote_line(&remote, Some(&args));
        assert!(line.starts_with("ssh -t -p 2200 -- 'me@host' "), "{line}");
        let printed = Command::new("sh").args(["-c", &line.replacen("ssh", "printf '%s\\n'", 1)]).output().unwrap();
        let words: Vec<String> = String::from_utf8(printed.stdout).unwrap().lines().map(String::from).collect();
        assert_eq!(words[..5], ["-t", "-p", "2200", "--", "me@host"]);
        let there = Command::new("sh").args(["-c", &format!("cd() {{ printf '%s|' \"$1\"; }}; git() {{ printf '%s|' \"$@\"; }}; {}", words[5])]).output().unwrap();
        assert_eq!(String::from_utf8(there.stdout).unwrap(), "/srv/it's here|rebase|-i|a b|");
        assert!(remote_line(&remote, None).ends_with("exec $SHELL -l'"));
    }

    #[test]
    fn quoting() {
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(applescript_quote(r#"say "hi" \ bye"#), r#""say \"hi\" \\ bye""#);
    }

    #[test]
    fn open_url_refuses_other_schemes() {
        assert!(open_url("file:///etc/passwd".into()).is_err());
        assert!(open_url("javascript:alert(1)".into()).is_err());
    }
}
