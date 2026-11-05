//! What the app keeps between launches, in `~/Library/Application Support/dev.kigi.gitgraph/`
//! (`GG_DATA_DIR` moves it elsewhere; the self-test does, so it never touches the user's files):
//!
//! - `state.json`: the view state the host and the webview persist (repo states, global and
//!   workspace view state, code reviews, the webview state of each folder). Held in memory,
//!   shared by all windows: [`state_snapshot`] hands a page all of it at boot, [`state_set`]
//!   changes one key, tells the other windows (`state-changed`) and writes the file shortly after
//!   (writes coalesce: the webview saves its scroll position often).
//! - `settings.json`: the user's settings, keyed like upstream's extension settings
//!   (`"graph.style": "angular"`). Read fresh each time and rewritten key by key, so it can also
//!   be edited by hand; a change through the app tells every window (`settings-changed`).
//! - `session.log`: the host log of this launch, while the `enableLog` setting is on.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gg_backend::files::write_atomic;
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// How long a change waits for others before the file is written.
const COALESCE: Duration = Duration::from_millis(300);

pub fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    std::env::var_os("GG_DATA_DIR").map(PathBuf::from).or_else(|| app.path().app_data_dir().ok())
}

/* ---------- state.json ---------- */

pub struct State {
    values: Arc<Mutex<Map<String, Value>>>,
    file: Option<PathBuf>,
    dirty: Mutex<mpsc::Sender<()>>,
}

impl State {
    /// Load `file` (missing or unreadable: empty) and start the writer.
    pub fn open(file: Option<PathBuf>) -> State {
        let loaded: Map<String, Value> = file
            .as_deref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let values = Arc::new(Mutex::new(loaded));
        let (tx, rx) = mpsc::channel::<()>();
        if let Some(file) = file.clone() {
            let values = values.clone();
            std::thread::spawn(move || {
                // One write per burst of changes; exits when the State (the sender) is dropped.
                while rx.recv().is_ok() {
                    std::thread::sleep(COALESCE);
                    while rx.try_recv().is_ok() {}
                    write_values(&file, &values);
                }
            });
        }
        State { values, file, dirty: Mutex::new(tx) }
    }

    pub fn snapshot(&self) -> Map<String, Value> {
        self.values.lock().unwrap().clone()
    }

    /// Set (`Some`) or remove (`None`) one key; the file follows shortly.
    pub fn set(&self, key: String, value: Option<Value>) {
        {
            let mut values = self.values.lock().unwrap();
            match value {
                Some(v) => values.insert(key, v),
                None => values.remove(&key),
            };
        }
        let _ = self.dirty.lock().unwrap().send(());
    }

    /// Write now (at exit: the writer thread may still be waiting out [`COALESCE`]).
    pub fn flush(&self) {
        if let Some(file) = &self.file {
            write_values(file, &self.values);
        }
    }
}

fn write_values(file: &Path, values: &Mutex<Map<String, Value>>) {
    let json = serde_json::to_vec(&*values.lock().unwrap()).unwrap_or_default();
    if let Err(e) = write_atomic(file, &json) {
        eprintln!("[state] cannot write {}: {e}", file.display());
    }
}

#[derive(Clone, Serialize)]
struct StateChanged {
    from: String,
    key: String,
    value: Option<Value>,
}

#[tauri::command]
pub fn state_snapshot(state: tauri::State<'_, State>) -> Map<String, Value> {
    state.snapshot()
}

#[tauri::command]
pub fn state_set(app: AppHandle, window: tauri::Window, state: tauri::State<'_, State>, key: String, value: Option<Value>) {
    state.set(key.clone(), value.clone());
    let _ = app.emit("state-changed", StateChanged { from: window.label().to_string(), key, value });
}

/* ---------- settings.json ---------- */

fn settings_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    data_dir(app).map(|d| d.join("settings.json")).ok_or_else(|| "no application data directory".to_string())
}

/// The settings in `file`: missing is empty; anything but a JSON object is an error (and is
/// never overwritten - it holds the user's hand edits).
pub fn read_settings(file: &Path) -> Result<Map<String, Value>, String> {
    match std::fs::read_to_string(file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(format!("Cannot read {}: {e}", file.display())),
        Ok(text) if text.trim().is_empty() => Ok(Map::new()),
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(map)) => Ok(map),
            Ok(_) => Err(format!("{} must hold a JSON object.", file.display())),
            Err(e) => Err(format!("{} is not valid JSON: {e}", file.display())),
        },
    }
}

/// `file` with one setting set (`Some`) or reset to its default (`None`).
pub fn write_setting(file: &Path, key: &str, value: Option<Value>) -> Result<(), String> {
    let mut settings = read_settings(file)?;
    match value {
        Some(v) => settings.insert(key.to_string(), v),
        None => settings.remove(key),
    };
    let mut text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    text.push('\n');
    write_atomic(file, text.as_bytes()).map_err(|e| format!("Cannot write {}: {e}", file.display()))
}

/// The settings as they are in settings.json now.
pub fn settings<R: Runtime>(app: &AppHandle<R>) -> Result<Map<String, Value>, String> {
    read_settings(&settings_file(app)?)
}

#[tauri::command]
pub fn settings_read(app: AppHandle) -> Result<Map<String, Value>, String> {
    settings(&app)
}

#[tauri::command]
pub fn settings_write(app: AppHandle, key: String, value: Option<Value>) -> Result<(), String> {
    write_setting(&settings_file(&app)?, &key, value)?;
    let _ = app.emit("settings-changed", ());
    Ok(())
}

/// The settings file, created (empty) if missing - to open it in an editor.
#[tauri::command]
pub fn settings_path(app: AppHandle) -> Result<String, String> {
    let file = settings_file(&app)?;
    if !file.exists() {
        write_atomic(&file, b"{\n}\n").map_err(|e| e.to_string())?;
    }
    Ok(file.display().to_string())
}

/* ---------- session.log ---------- */

pub struct SessionLog(pub Option<PathBuf>);

impl SessionLog {
    /// This launch's log: the previous launch's is removed.
    pub fn start(dir: Option<PathBuf>) -> SessionLog {
        let file = dir.map(|d| d.join("session.log"));
        if let Some(f) = &file {
            let _ = std::fs::remove_file(f);
        }
        SessionLog(file)
    }

    pub fn append(&self, line: &str) {
        let Some(file) = &self.0 else { return };
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
            let _ = writeln!(f, "{line}");
        }
    }
}

/// The session log, created (empty) if nothing was logged yet - to open it.
#[tauri::command]
pub fn session_log_path(log: tauri::State<'_, SessionLog>) -> Result<String, String> {
    let file = log.0.clone().ok_or("no application data directory")?;
    if !file.exists() {
        write_atomic(&file, b"").map_err(|e| e.to_string())?;
    }
    Ok(file.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn state_survives_a_reopen_and_coalesces_writes() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sub/state.json");
        let state = State::open(Some(file.clone()));
        for i in 0..50 {
            state.set("scroll".into(), Some(json!(i)));
        }
        state.set("gone".into(), Some(json!(true)));
        state.set("gone".into(), None);
        std::thread::sleep(COALESCE * 3);
        let reopened = State::open(Some(file.clone()));
        assert_eq!(reopened.snapshot().get("scroll"), Some(&json!(49)));
        assert!(!reopened.snapshot().contains_key("gone"));
        // flush writes at once
        reopened.set("now".into(), Some(json!("yes")));
        reopened.flush();
        assert_eq!(State::open(Some(file)).snapshot().get("now"), Some(&json!("yes")));
    }

    #[test]
    fn a_corrupt_state_file_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state.json");
        std::fs::write(&file, "{ not json").unwrap();
        assert!(State::open(Some(file)).snapshot().is_empty());
    }

    #[test]
    fn settings_are_rewritten_key_by_key_and_hand_edits_are_never_clobbered() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        assert!(read_settings(&file).unwrap().is_empty());
        std::fs::write(&file, "{ \"graph.style\": \"angular\", \"unknown.key\": 1 }").unwrap();
        write_setting(&file, "stickyHeader", Some(json!(false))).unwrap();
        let settings = read_settings(&file).unwrap();
        assert_eq!(settings.get("graph.style"), Some(&json!("angular")));
        assert_eq!(settings.get("unknown.key"), Some(&json!(1)));
        assert_eq!(settings.get("stickyHeader"), Some(&json!(false)));
        write_setting(&file, "graph.style", None).unwrap();
        assert!(!read_settings(&file).unwrap().contains_key("graph.style"));

        std::fs::write(&file, "{ \"graph.style\": ").unwrap();
        assert!(read_settings(&file).unwrap_err().contains("not valid JSON"));
        assert!(write_setting(&file, "stickyHeader", Some(json!(true))).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ \"graph.style\": ");
        std::fs::write(&file, "[1]").unwrap();
        assert!(read_settings(&file).is_err());
    }
}
