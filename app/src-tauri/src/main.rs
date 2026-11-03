//! Git Graph for macOS - PoC.
//!
//! The upstream webview runs unchanged in the Tauri window; `ui/host/` plays the extension
//! host and reaches the engine through `engine_request`, which is upstream's single JSON entry
//! point (`git_graph_core::dispatch::request`) called in-process. Writes go through the `git`
//! CLI (`git` module); `repo` and `system` cover what VS Code used to provide.

mod askpass;
mod diff;
mod git;
mod repo;
mod repos;
mod state;
mod system;
mod watch;

use tauri::{Emitter, Manager};

/// Folders macOS asked the app to open (dropped on the Dock icon, `open -a`) before the first
/// window's page asked for its launch folders; after that they go straight to a window.
#[derive(Default)]
struct Launch(std::sync::Mutex<(bool, Vec<String>)>); // (asked, waiting)

/// The folders to open at launch: the first non-flag argument (else `GIT_GRAPH_REPO`), then
/// those macOS has handed over so far.
#[tauri::command]
fn initial_repo(launch: tauri::State<'_, Launch>) -> Vec<String> {
    let argument = std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-'))
        .or_else(|| std::env::var("GIT_GRAPH_REPO").ok())
        .map(|path| {
            std::fs::canonicalize(&path)
                .map(|p| p.display().to_string())
                .unwrap_or(path)
        });
    let mut launch = launch.0.lock().unwrap();
    launch.0 = true;
    argument.into_iter().chain(launch.1.drain(..)).collect()
}

/// macOS's "open these" (RunEvent::Opened): kept for the first window until its page asks, then
/// shown like File > Open.
#[cfg(target_os = "macos")]
fn opened(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    let folders: Vec<String> = urls
        .iter()
        .filter_map(|u| u.to_file_path().ok())
        .map(|p| p.canonicalize().unwrap_or(p).display().to_string()) // no trailing slash
        .collect();
    {
        let launch = app.state::<Launch>();
        let mut launch = launch.0.lock().unwrap();
        if !launch.0 {
            launch.1.extend(folders);
            return;
        }
    }
    for folder in folders {
        if let Err(e) = repos::open_folder(app, &folder) {
            eprintln!("cannot open {folder}: {e}");
        }
    }
}

/// One engine call: `{"method", "params"}` in, the method's JSON answer out. Failures ride
/// in-band as `{"error": "Kind: message"}`. Runs off the main thread - a large repository's
/// first graph page takes long enough to stall the UI otherwise.
#[tauri::command]
async fn engine_request(repo: String, request: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_graph_core::dispatch::request(&repo, &request)
    })
    .await
    .map_err(|e| e.to_string())
}

/// The host's log line, mirrored to stderr so it shows in the terminal; with `persist` (the
/// `enableLog` setting) also appended to this launch's session log.
#[tauri::command]
fn host_log(log: tauri::State<'_, state::SessionLog>, line: String, persist: Option<bool>) {
    eprintln!("[host] {line}");
    if persist == Some(true) {
        log.append(&line);
    }
}

/// Whether the page should run its built-in end-to-end check (`GG_SELFTEST=1`), and with what:
/// `GG_SELFTEST_HTTP` names an HTTP Basic-auth URL for the real-git credential prompt check.
#[tauri::command]
fn self_test() -> Option<serde_json::Value> {
    std::env::var("GG_SELFTEST").is_ok_and(|v| v == "1").then(|| {
        serde_json::json!({ "httpUrl": std::env::var("GG_SELFTEST_HTTP").ok() })
    })
}

/// `GG_PREVIEW=<scene>[,<scene>…][,contrast]`: open the view in a given state and leave it
/// there, to look at (screenshots of the theme): see `runPreview` in host/main.js. `contrast`
/// forces Increase Contrast, which cannot be switched for one app.
#[tauri::command]
fn preview() -> Option<String> {
    std::env::var("GG_PREVIEW").ok().filter(|p| !p.is_empty())
}

/// The `resize` preview scene: the window resized as a person would drag it. Only under
/// `GG_PREVIEW`.
#[tauri::command]
fn preview_resize(window: tauri::Window, width: f64, height: f64) -> Result<(), String> {
    if preview().is_none() {
        return Err("only in GG_PREVIEW".into());
    }
    window.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())
}

fn main() {
    // Started by git or ssh as their askpass program: answer the prompt and exit, no window.
    if let Some(code) = askpass::helper_main() {
        std::process::exit(code);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(git::GitJobs::default())
        .manage(repos::Windows::default())
        .manage(Launch::default())
        .menu(repos::menu)
        .on_menu_event(|app, event| repos::on_menu_event(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                repos::window_closed(window.app_handle(), window.label());
            }
        })
        .setup(|app| {
            // The configured window starts on the start page until its page opens a folder.
            app.state::<repos::Windows>().0.lock().unwrap().entry("main".into()).or_default();
            let data = state::data_dir(app.handle());
            let saved = state::State::open(data.as_ref().map(|d| d.join("state.json")));
            // localStorage is shared by every launch whatever its data directory: only the
            // default one may take over what earlier versions kept there (host/main.js).
            if std::env::var_os("GG_DATA_DIR").is_some() && !saved.snapshot().contains_key("migratedFromLocalStorage") {
                saved.set("migratedFromLocalStorage".into(), Some(serde_json::Value::Bool(true)));
            }
            app.manage(saved);
            let appearance = repos::saved_appearance(app.handle());
            let _ = repos::apply_appearance(app.handle(), &appearance);
            app.manage(state::SessionLog::start(data));
            repos::rebuild_recent_menu(app.handle());
            let handle = app.handle().clone();
            // To the window whose git asked (each window shows its own prompts).
            let askpass = askpass::Askpass::start(std::sync::Arc::new(move |window: &str, event| {
                handle.get_webview_window(window).is_some() && handle.emit_to(window, "askpass", event).is_ok()
            }))?;
            app.manage(askpass);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initial_repo,
            engine_request,
            host_log,
            self_test,
            preview,
            preview_resize,
            git::git_exec,
            git::git_cancel,
            git::git_info,
            repo::repo_operation_state,
            repo::export_repo_config,
            system::clipboard_write,
            system::open_url,
            system::open_path,
            system::open_terminal,
            askpass::askpass_reply,
            diff::open_diff_window,
            diff::worktree_file,
            repos::scan_repos,
            repos::recent_repos,
            repos::repo_opened,
            repos::open_repo_folder,
            repos::open_new_window,
            repos::set_appearance,
            repos::get_appearance,
            state::state_snapshot,
            state::state_set,
            state::settings_read,
            state::settings_write,
            state::settings_path,
            state::session_log_path
        ])
        .build(tauri::generate_context!())
        .expect("error while building Git Graph")
        .run(|app, event| {
            // The view state is written shortly after each change: write what is pending now.
            match event {
                tauri::RunEvent::Exit => app.state::<state::State>().flush(),
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => opened(app, urls),
                _ => {}
            }
        });
}
