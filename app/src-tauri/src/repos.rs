//! Repositories and windows: which repository each window shows, the recent list (File > Open
//! Recent and the start page), scanning a folder for repositories, and the file watcher of each
//! window.
//!
//! Every window has the repository sidebar (host/sidebar.js: the list is shared, kept in
//! state.json) and shows one of its repositories. A window starts on the start page (an empty
//! list) or with `window.__GG_OPEN_REPO` set; its page reports `repo_opened` whenever the
//! repository it shows or the list changes: that records it, remembers it as recent, and
//! (when the list changed) watches the list's repositories (events `repo-changed`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

const MAX_RECENT: usize = 10;
/// How deep a folder that is not itself a repository is searched for repositories.
const SCAN_DEPTH: usize = 3;
/// Directories never searched: dependencies and build output hold no repositories worth listing.
const SKIP_DIRS: [&str; 4] = ["node_modules", "target", "build", "dist"];

/* ---------- Scanning ---------- */

/// The repositories in `folder` (not itself a repository), at most `depth` levels down,
/// sorted. A repository found is not searched further (its submodules and vendored checkouts
/// belong to it); hidden directories and [`SKIP_DIRS`] are skipped.
pub fn scan(folder: &Path, depth: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut level = vec![folder.to_path_buf()];
    for _ in 0..depth {
        let mut next = Vec::new();
        for dir in level {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !entry.file_type().is_ok_and(|t| t.is_dir()) || name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
                    continue;
                }
                if path.join(".git").exists() {
                    found.push(path);
                } else {
                    next.push(path);
                }
            }
        }
        level = next;
    }
    found.sort();
    found
}

#[tauri::command]
pub fn scan_repos(folder: String) -> Vec<String> {
    scan(Path::new(&folder), SCAN_DEPTH).into_iter().map(|p| p.display().to_string()).collect()
}

/* ---------- Recent folders ---------- */

/// `~/Library/Application Support/dev.kigi.gitgraph/recent.json`; `GG_DATA_DIR` moves it
/// elsewhere (the self-test does, so it never touches the user's list).
fn recent_file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    crate::state::data_dir(app).map(|d| d.join("recent.json"))
}

/// The recent folders, most recent first, those that still exist.
pub fn recent<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let list: Vec<String> = recent_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    list.into_iter().filter(|p| Path::new(p).is_dir()).collect()
}

/// `list` with `folder` moved to the front, at most [`MAX_RECENT`] long.
fn push_recent(mut list: Vec<String>, folder: &str) -> Vec<String> {
    list.retain(|p| p != folder);
    list.insert(0, folder.to_string());
    list.truncate(MAX_RECENT);
    list
}

fn remember<R: Runtime>(app: &AppHandle<R>, folder: &str) {
    let Some(file) = recent_file(app) else { return };
    let list = push_recent(recent(app), folder);
    let _ = crate::state::write_atomic(&file, serde_json::to_string_pretty(&list).unwrap_or_default().as_bytes());
    rebuild_recent_menu(app);
}

#[tauri::command]
pub fn recent_repos(app: AppHandle) -> Vec<String> {
    recent(&app)
}

/* ---------- Windows ---------- */

/// What each window shows (`None`: the start page), the repositories it watches, its watcher.
#[derive(Default)]
pub struct Windows(pub Mutex<HashMap<String, WindowState>>);

#[derive(Default)]
pub struct WindowState {
    folder: Option<String>,
    watched: Vec<String>,
    _watcher: Option<notify::RecommendedWatcher>,
}

#[derive(Clone, Serialize)]
struct RepoChanged {
    repos: Vec<String>,
}

/// The page of `window` shows `folder` (a repository of the sidebar's `repos`): record it,
/// remember it, and watch `repos` (anew only when they changed).
#[tauri::command]
pub fn repo_opened(app: AppHandle, window: tauri::Window, windows: tauri::State<'_, Windows>, folder: String, repos: Vec<String>) -> Result<(), String> {
    let label = window.label().to_string();
    {
        let mut all = windows.0.lock().unwrap();
        if let Some(state) = all.get_mut(&label).filter(|w| w._watcher.is_some() && same_repos(&w.watched, &repos)) {
            state.folder = Some(folder.clone());
            drop(all);
            remember(&app, &folder);
            return Ok(());
        }
    }
    // Without git the watcher still works; it just cannot tell ignored files apart.
    let git = crate::git::locate_git().ok().map(|g| PathBuf::from(&g.path));
    let target = label.clone();
    let emitter = app.clone();
    let watcher = crate::watch::watch(git, repos.iter().map(PathBuf::from).collect(), move |changed| {
        let repos = changed.into_iter().map(|p| p.display().to_string()).collect();
        let _ = emitter.emit_to(target.as_str(), "repo-changed", RepoChanged { repos });
    })
    .map_err(|e| format!("cannot watch {folder}: {e}"))?;
    windows.0.lock().unwrap().insert(label, WindowState { folder: Some(folder.clone()), watched: repos, _watcher: Some(watcher) });
    remember(&app, &folder);
    Ok(())
}

/// The same repositories, in any order (reordering the sidebar does not rewatch).
fn same_repos(a: &[String], b: &[String]) -> bool {
    let (mut a, mut b) = (a.to_vec(), b.to_vec());
    a.sort();
    b.sort();
    a == b
}

/// Forget a closed window (and stop its watcher).
pub fn window_closed<R: Runtime>(app: &AppHandle<R>, label: &str) {
    app.state::<Windows>().0.lock().unwrap().remove(label);
}

/// Show `folder` (File > Open…, Open Recent): in the window already showing it, else in the
/// focused window, else in any (its page adds it to the sidebar and switches to it); a new
/// window only when there is none.
pub fn open_folder<R: Runtime>(app: &AppHandle<R>, folder: &str) -> Result<(), String> {
    let folder = Path::new(folder).canonicalize().map(|p| p.display().to_string()).unwrap_or_else(|_| folder.to_string());
    let target = {
        let windows = app.state::<Windows>();
        let windows = windows.0.lock().unwrap();
        let showing = windows.iter().find(|(_, w)| w.folder.as_deref() == Some(folder.as_str())).map(|(l, _)| l.clone());
        let focused = app.webview_windows().into_values().find(|w| windows.contains_key(w.label()) && w.is_focused().unwrap_or(false)).map(|w| w.label().to_string());
        let main = windows.contains_key("main").then(|| "main".to_string());
        let any = windows.keys().next().cloned();
        showing.or(focused).or(main).or(any)
    };
    if let Some(window) = target.and_then(|label| app.get_webview_window(&label)) {
        let _ = window.unminimize();
        let _ = window.set_focus();
        // To that window only (`emit` would reach every window's listeners).
        return app.emit_to(window.label(), "open-repo", folder).map_err(|e| e.to_string());
    }
    new_window(app, Some(&folder))
}

/// A new window showing `repo` (the sidebar's Open in New Window).
#[tauri::command]
pub fn open_new_window(app: AppHandle, repo: String) -> Result<(), String> {
    new_window(&app, Some(&repo))
}

/// Show `folder` in a window (the same path as File > Open Recent).
#[tauri::command]
pub fn open_repo_folder(app: AppHandle, folder: String) -> Result<(), String> {
    open_folder(&app, &folder)
}

/// A new graph window, on the start page or opening `folder`.
pub fn new_window<R: Runtime>(app: &AppHandle<R>, folder: Option<&str>) -> Result<(), String> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let label = format!("repo-{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let script = match folder {
        Some(f) => format!("window.__GG_OPEN_REPO = {};", serde_json::to_string(f).map_err(|e| e.to_string())?),
        None => String::new(),
    };
    app.state::<Windows>().0.lock().unwrap().insert(label.clone(), WindowState::default());
    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
        .title("Your Git Graph")
        .inner_size(1280.0, 820.0)
        .min_inner_size(640.0, 400.0)
        .initialization_script(script)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/* ---------- Menus ---------- */

const OPEN_ID: &str = "open-repo";
const NEW_WINDOW_ID: &str = "new-window";
const RECENT_ID: &str = "open-recent";
const RECENT_PREFIX: &str = "recent:";

/// View > Appearance: `appearance:<system|light|dark>`.
const APPEARANCE_PREFIX: &str = "appearance:";
const APPEARANCES: [(&str, &str); 3] = [("system", "System"), ("light", "Light"), ("dark", "Dark")];

/// Menu items the focused graph window carries out (event `menu-command` with the part after
/// the prefix; `host/main.js` maps it to the view's own button or shortcut).
const COMMAND_PREFIX: &str = "command:";

/// The default menu (it carries Edit, without which ⌘C/⌘V do not work in text fields) with
/// Settings… in the app menu, New Window, Open Repository… and Open Recent at the top of File,
/// and the view's commands at the top of View.
pub fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let submenus: Vec<Submenu<R>> = menu
        .items()?
        .into_iter()
        .filter_map(|item| match item {
            MenuItemKind::Submenu(s) => Some(s),
            _ => None,
        })
        .collect();
    let named = |name: &str| submenus.iter().find(|s| s.text().ok().as_deref() == Some(name));
    let command = |id: &str, text: &str, accelerator: Option<&str>| MenuItem::with_id(app, format!("{COMMAND_PREFIX}{id}"), text, true, accelerator);

    // The app menu comes first: About, separator, then Settings… where macOS apps keep it.
    if let Some(app_menu) = submenus.first() {
        app_menu.insert(&command("settings", "Settings…", Some("CmdOrCtrl+,"))?, 2)?;
        app_menu.insert(&PredefinedMenuItem::separator(app)?, 3)?;
    }
    if let Some(file) = named("File") {
        let recent = Submenu::with_id(app, RECENT_ID, "Open Recent", true)?;
        file.insert(&MenuItem::with_id(app, NEW_WINDOW_ID, "New Window", true, Some("CmdOrCtrl+N"))?, 0)?;
        file.insert(&MenuItem::with_id(app, OPEN_ID, "Open Repository…", true, Some("CmdOrCtrl+O"))?, 1)?;
        file.insert(&recent, 2)?;
        file.insert(&PredefinedMenuItem::separator(app)?, 3)?;
    }
    if let Some(view) = named("View") {
        // ⌘R and ⌘F are the view's own shortcuts too; the menu takes the keys first and hands
        // them back. HEAD gets ⌘J: the view's ⌘H is Hide on macOS.
        let items = [
            command("refresh", "Refresh", Some("CmdOrCtrl+R"))?,
            command("find", "Find…", Some("CmdOrCtrl+F"))?,
            command("head", "Show HEAD Commit", Some("CmdOrCtrl+J"))?,
            command("fetch", "Fetch from Remotes", Some("CmdOrCtrl+Shift+F"))?,
            command("sidebar", "Toggle Sidebar", Some("Ctrl+Super+S"))?,
        ];
        for (i, item) in items.iter().enumerate() {
            view.insert(item, i)?;
        }
        let appearance = Submenu::new(app, "Appearance", true)?;
        for (id, text) in APPEARANCES {
            appearance.append(&CheckMenuItem::with_id(app, format!("{APPEARANCE_PREFIX}{id}"), text, true, id == "system", None::<&str>)?)?;
        }
        view.insert(&PredefinedMenuItem::separator(app)?, items.len())?;
        view.insert(&appearance, items.len() + 1)?;
        view.insert(&PredefinedMenuItem::separator(app)?, items.len() + 2)?;
    }
    Ok(menu)
}

fn recent_submenu<R: Runtime>(app: &AppHandle<R>) -> Option<Submenu<R>> {
    match app.menu()?.get(RECENT_ID)? {
        MenuItemKind::Submenu(s) => Some(s),
        _ => None,
    }
}

/// Refill File > Open Recent from the recent list.
pub fn rebuild_recent_menu<R: Runtime>(app: &AppHandle<R>) {
    let Some(submenu) = recent_submenu(app) else { return };
    if let Ok(items) = submenu.items() {
        for item in items {
            let _ = submenu.remove(&item);
        }
    }
    let list = recent(app);
    for (i, folder) in list.iter().enumerate() {
        if let Ok(item) = MenuItem::with_id(app, format!("{RECENT_PREFIX}{i}"), folder, true, None::<&str>) {
            let _ = submenu.append(&item);
        }
    }
    let _ = submenu.set_enabled(!list.is_empty());
}

/* ---------- Appearance ---------- */

/// The saved appearance (`state.json` key `appearance`): `system`, `light` or `dark`.
pub fn saved_appearance<R: Runtime>(app: &AppHandle<R>) -> String {
    app.state::<crate::state::State>()
        .snapshot()
        .get("appearance")
        .and_then(|v| v.as_str())
        .filter(|a| APPEARANCES.iter().any(|(id, _)| id == a))
        .unwrap_or("system")
        .to_string()
}

/// Draw every window (app-wide on macOS) in `appearance`, tick it in View > Appearance, and
/// remember it. The pages follow by themselves: WebKit reports it as prefers-color-scheme.
pub fn apply_appearance<R: Runtime>(app: &AppHandle<R>, appearance: &str) -> Result<(), String> {
    let theme = match appearance {
        "system" => None,
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        other => return Err(format!("unknown appearance {other}")),
    };
    app.set_theme(theme);
    if let Some(menu) = app.menu() {
        for (id, _) in APPEARANCES {
            if let Some(MenuItemKind::Check(item)) = menu.get(&format!("{APPEARANCE_PREFIX}{id}")) {
                let _ = item.set_checked(id == appearance);
            }
        }
    }
    let state = app.state::<crate::state::State>();
    if appearance == "system" {
        state.set("appearance".into(), None);
    } else {
        state.set("appearance".into(), Some(serde_json::Value::String(appearance.into())));
    }
    Ok(())
}

#[tauri::command]
pub fn set_appearance(app: AppHandle, appearance: String) -> Result<(), String> {
    apply_appearance(&app, &appearance)
}

#[tauri::command]
pub fn get_appearance(app: AppHandle) -> String {
    saved_appearance(&app)
}

pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(appearance) = id.strip_prefix(APPEARANCE_PREFIX) {
        let _ = apply_appearance(app, appearance);
    } else if let Some(command) = id.strip_prefix(COMMAND_PREFIX) {
        let focused = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false));
        if let Some(window) = focused {
            let _ = app.emit_to(window.label(), "menu-command", command);
        }
    } else if id == NEW_WINDOW_ID {
        let _ = new_window(app, None);
    } else if id == OPEN_ID {
        let handle = app.clone();
        app.dialog().file().set_title("Open Git Repository").pick_folder(move |picked| {
            if let Some(path) = picked.and_then(|p| p.into_path().ok()) {
                let _ = open_folder(&handle, &path.display().to_string());
            }
        });
    } else if let Some(index) = id.strip_prefix(RECENT_PREFIX).and_then(|i| i.parse::<usize>().ok()) {
        if let Some(folder) = recent(app).get(index) {
            let _ = open_folder(app, folder);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanning_finds_repositories_without_descending_into_them() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        for repo in ["a", "group/b", "group/deep/c", "a/vendor/inner", "node_modules/pkg", ".hidden/x", "one/two/three/four"] {
            std::fs::create_dir_all(p.join(repo).join(".git")).unwrap();
        }
        std::fs::create_dir_all(p.join("worktree")).unwrap();
        std::fs::write(p.join("worktree/.git"), "gitdir: /somewhere\n").unwrap();
        let found: Vec<String> = scan(p, SCAN_DEPTH).iter().map(|f| f.strip_prefix(p).unwrap().display().to_string()).collect();
        assert_eq!(found, ["a", "group/b", "group/deep/c", "worktree"]);
    }

    #[test]
    fn recent_list_is_most_recent_first_unique_and_bounded() {
        let mut list = Vec::new();
        for i in 0..12 {
            list = push_recent(list, &format!("/r{i}"));
        }
        list = push_recent(list, "/r5");
        assert_eq!(list.len(), MAX_RECENT);
        assert_eq!(list[0], "/r5");
        assert_eq!(list[1], "/r11");
        assert_eq!(list.iter().filter(|p| *p == "/r5").count(), 1);
    }
}
