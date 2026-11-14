//! Your Git Graph: a macOS git graph app (Tauri 2) around the git-graph-core engine.
//!
//! The front end (web/, Svelte) runs in the Tauri windows and reaches a repository through the
//! typed commands of `api`, which run the engine (`git_graph_core`) in-process and the `git` CLI
//! for writes; the diff windows read through `engine_request`. `repo`, `repos` and `system`
//! cover the app's own concerns: repositories, windows, menus, macOS integration.
//!
//! What a window may call is in `capabilities/`: a diff window shows a repository's documents,
//! and reads only (build.rs lists every command, which makes each one opt-in).

mod api;
mod askpass;
mod diff;
mod git;
mod plantuml;
mod remote;
mod repo;
mod repos;
mod settings;
mod state;
mod system;

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

/// The engine methods a page may call: what a diff window reads. Everything else goes through
/// the typed `repo_read`, so the engine's other methods (`submodules` follows paths named by a
/// repository's `.gitmodules` out of it, say) are not within a page's reach.
const PAGE_ENGINE_METHODS: [&str; 5] = ["loadCommitFile", "fileBytes", "loadCommitDetails", "loadUncommittedDetails", "compareCommits"];

fn page_may_call(request: &str) -> Result<(), String> {
    let request: serde_json::Value = serde_json::from_str(request).map_err(|e| e.to_string())?;
    match request["method"].as_str() {
        Some(method) if PAGE_ENGINE_METHODS.contains(&method) => Ok(()),
        method => Err(format!("The engine method {} is not available here.", method.unwrap_or("(none)"))),
    }
}

/// One engine call: `{"method", "params"}` in, the method's JSON answer out. Failures ride
/// in-band as `{"error": "Kind: message"}`. A remote repository's go to its machine. Runs off the main thread - a large repository's
/// first graph page takes long enough to stall the UI otherwise.
#[tauri::command]
async fn engine_request(state: tauri::State<'_, state::State>, remotes: tauri::State<'_, std::sync::Arc<remote::Remotes>>, repo: String, request: String) -> Result<String, String> {
    state.listed(&repo)?;
    page_may_call(&request)?;
    if let Some(remote) = remote::parse(&repo)? {
        let session = remotes.session(&remote)?;
        let body = serde_json::json!({ "op": "engine", "repo": remote.path, "request": request });
        let answer = session.call(session.next_id(), &body, |_| {}).await?;
        return String::from_utf8(answer).map_err(|e| e.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || gg_backend::engine(&repo, &request))
        .await
        .map_err(|e| e.to_string())
}

/// The host's log line, mirrored to stderr so it shows in the terminal, and appended to this
/// launch's session log when the `log.enabled` setting is on (read from the file each time, so
/// turning it on in the panel or by hand takes effect at once); `persist` overrides the setting.
#[tauri::command]
fn host_log(app: tauri::AppHandle, log: tauri::State<'_, state::SessionLog>, line: String, persist: Option<bool>) {
    eprintln!("[host] {line}");
    let keep = persist.unwrap_or_else(|| {
        state::settings_file(&app).and_then(|f| settings::load(&f)).is_ok_and(|view| view.settings.log_enabled)
    });
    if keep {
        log.append(&line);
    }
}

/// Whether the page should run its built-in end-to-end check (`GG_SELFTEST=1`), and with what:
/// `GG_SELFTEST_HTTP` names an HTTP Basic-auth URL for the real-git credential prompt check;
/// with `GG_REMOTE_SSH` (a stand-in for ssh) the repository is also opened as a remote one, or
/// with `GG_SELFTEST_SSH` (and `GG_SELFTEST_SSH_PASSWORD`) that repository through the real ssh;
/// with `GG_PLANTUML_JAVA` (a stand-in for java) a PlantUML block of the Markdown preview is
/// drawn, or with `GG_SELFTEST_PLANTUML_JAR` by that plantuml.jar and the real java.
#[tauri::command]
fn self_test() -> Option<serde_json::Value> {
    std::env::var("GG_SELFTEST").is_ok_and(|v| v == "1").then(|| {
        serde_json::json!({ "httpUrl": std::env::var("GG_SELFTEST_HTTP").ok(), "remote": std::env::var_os("GG_REMOTE_SSH").is_some(),
            "sshUrl": std::env::var("GG_SELFTEST_SSH").ok(), "sshPassword": std::env::var("GG_SELFTEST_SSH_PASSWORD").ok(),
            "plantumlJava": std::env::var_os("GG_PLANTUML_JAVA").is_some(), "plantumlJar": std::env::var("GG_SELFTEST_PLANTUML_JAR").ok() })
    })
}

/// Under `GG_SELFTEST` only: a file of the self-test's own (a Markdown document, an image) put
/// into the working tree of a local repository, under its `gg-selftest/` directory, to be
/// shown and removed again by the test.
#[tauri::command]
fn selftest_write(repo: String, path: String, contents: Vec<u8>) -> Result<(), String> {
    if self_test().is_none() {
        return Err("only under GG_SELFTEST".into());
    }
    if remote::parse(&repo)?.is_some() {
        return Err("local repositories only".into());
    }
    if !path.starts_with("gg-selftest/") || path.split('/').any(|part| part.is_empty() || part == "..") {
        return Err("a path under gg-selftest/ only".into());
    }
    gg_backend::files::write_atomic(&std::path::Path::new(&repo).join(path), &contents).map_err(|e| e.to_string())
}

/// Whether the windows stay in front of every other app's (the self-test, a preview): a bundled
/// app whose windows are covered - by the terminal that started it - is managed by macOS like
/// any background app, and WebKit then freezes its pages (timers, drawing, the IPC) once the
/// appearance changes or some seconds pass, until the app is brought forward. A bare binary
/// (cargo build) is left alone, which hides this in development.
fn kept_in_front() -> bool {
    self_test().is_some() || preview().is_some()
}

/// `GG_PREVIEW=<scene>[,<scene>…][,contrast]`: open the view in a given state and leave it
/// there, to look at (screenshots of the theme): see web/src/preview.ts. `contrast`
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
    // Started from the Finder or the Dock, PATH lacks Homebrew: git-lfs and friends not found.
    gg_backend::git::extend_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(api::Jobs::default())
        .manage(repos::Windows::default())
        .manage(Launch::default())
        .manage(plantuml::Cache::default())
        .menu(repos::menu)
        .on_menu_event(|app, event| repos::on_menu_event(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                repos::window_closed(window.app_handle(), window.label());
            }
        })
        .setup(|app| {
            if kept_in_front() {
                system::no_app_nap("self-test or preview in progress");
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_always_on_top(true);
                }
            }
            // The configured window starts on the start page until its page opens a folder.
            app.state::<repos::Windows>().0.lock().unwrap().entry("main".into()).or_default();
            let data = state::data_dir(app.handle());
            let saved = state::State::open(data.as_ref().map(|d| d.join("state.json")));
            // localStorage is shared by every launch whatever its data directory: only the
            // default one may take over what earlier versions kept there.
            if std::env::var_os("GG_DATA_DIR").is_some() && !saved.snapshot().contains_key("migratedFromLocalStorage") {
                saved.set("migratedFromLocalStorage".into(), Some(serde_json::Value::Bool(true)));
            }
            let dropped = saved.migrate_v2();
            if dropped > 0 {
                eprintln!("[state] dropped {dropped} keys of the first version's state");
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
            app.manage(remote::start(app.handle()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initial_repo,
            api::repo_read,
            api::repo_op,
            api::repo_op_cancel,
            engine_request,
            host_log,
            self_test,
            selftest_write,
            preview,
            preview_resize,
            repo::export_repo_config,
            system::clipboard_write,
            system::open_url,
            system::open_repo_file,
            system::reveal_repo,
            system::open_terminal,
            system::mount_volume,
            system::network_volume,
            askpass::askpass_reply,
            remote::remote_connect,
            remote::remote_disconnect,
            diff::open_diff_window,
            diff::worktree_file,
            plantuml::render_plantuml,
            repos::scan_repos,
            repos::recent_repos,
            repos::repo_opened,
            repos::open_new_window,
            repos::set_appearance,
            state::state_snapshot,
            state::state_set,
            settings::settings_get,
            settings::settings_set,
            state::open_settings_file,
            state::open_session_log
        ])
        .build(tauri::generate_context!())
        .expect("error while building Your Git Graph")
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

#[cfg(test)]
mod tests {
    use super::*;

    fn quoted(text: &str) -> Vec<String> {
        text.split('"').skip(1).step_by(2).map(String::from).collect()
    }

    /// A command missing from build.rs would be open to every window, so the lists are compared.
    #[test]
    fn every_command_is_opt_in() {
        let source = include_str!("main.rs");
        let handler = source.split_once("generate_handler![").unwrap().1.split_once(']').unwrap().0;
        let mut registered: Vec<&str> = handler.split(',').map(str::trim).filter(|c| !c.is_empty()).map(|c| c.rsplit("::").next().unwrap()).collect();
        registered.sort();
        let build = include_str!("../build.rs");
        let listed = build.split_once("COMMANDS: &[&str] = &[").unwrap().1.split_once("];").unwrap().0;
        let mut listed = quoted(listed);
        listed.sort();
        assert_eq!(registered, listed);
    }

    /// A diff window renders what a repository's author wrote: no command of it writes, runs git
    /// or a program a page names, or changes what the others trust (the sidebar, the settings).
    #[test]
    fn a_diff_window_only_reads() {
        let capability: serde_json::Value = serde_json::from_str(include_str!("../capabilities/diff.json")).unwrap();
        let mut allowed: Vec<&str> = capability["permissions"].as_array().unwrap().iter().filter_map(|p| p.as_str()?.strip_prefix("allow-")).collect();
        allowed.sort();
        assert_eq!(allowed, ["engine-request", "host-log", "open-settings-file", "open-url", "render-plantuml", "self-test", "worktree-file"]);
    }

    #[test]
    fn a_page_reads_only_what_a_diff_window_needs() {
        assert!(page_may_call(r#"{"method":"loadCommitFile","params":{"commitHash":"HEAD","file":"a"}}"#).is_ok());
        assert!(page_may_call(r#"{"method":"submodules"}"#).unwrap_err().contains("submodules"));
        assert!(page_may_call(r#"{"params":{}}"#).is_err());
        assert!(page_may_call("not json").is_err());
    }
}
