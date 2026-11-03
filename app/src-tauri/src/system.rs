//! macOS integrations the VS Code host got from the editor: the clipboard, opening URLs and
//! files with their default app, and Terminal.

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

/// Open Terminal in `cwd`; with `args`, also run `git <args>` there (interactive rebase needs a
/// real terminal for its editor).
#[tauri::command]
pub fn open_terminal(cwd: String, git_args: Option<Vec<String>>) -> Result<(), String> {
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
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script {}\nend tell",
        applescript_quote(&line)
    );
    run(Command::new("/usr/bin/osascript").args(["-e", &script]))
}

#[cfg(test)]
mod tests {
    use super::*;

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
