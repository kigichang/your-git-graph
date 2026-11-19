//! The diff windows (web/diff.html, a Monaco editor) and the working-tree reads they need.
//! Revision contents come from the engine; only the working tree is read here.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use gg_backend::files::read_worktree_file;
use serde_json::{json, Value};

use crate::remote::{self, Remotes};

/// Open a diff window. `spec` (JSON, built by web/src/lib/diffspec.ts) tells the page what to show;
/// it is handed over as a global set before the page's scripts run.
#[tauri::command]
pub fn open_diff_window(app: tauri::AppHandle, spec: String, title: String) -> Result<(), String> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    // Re-serialised: only well-formed JSON reaches the initialisation script.
    let spec: serde_json::Value = serde_json::from_str(&spec).map_err(|e| e.to_string())?;
    let label = format!("diff-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let dev = app.config().build.dev_url.clone();
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App("diff.html".into()))
        .title(title)
        .inner_size(1100.0, 760.0)
        .min_inner_size(480.0, 320.0)
        .always_on_top(crate::kept_in_front()) // above the main window, which is in front too
        .initialization_script(format!("window.__GG_DIFF_SPEC = {spec};"))
        // It shows a repository's documents: wherever one of them would take the window (a link
        // followed some way the page did not catch), it stays on the app's own pages.
        .on_navigation(move |url| own_page(url, dev.as_ref()))
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Whether `url` is a page of the app itself: its own scheme (or, under `cargo tauri dev`, the
/// dev server), not a site or another app's scheme.
fn own_page(url: &tauri::Url, dev: Option<&tauri::Url>) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost")) || dev.is_some_and(|dev| url.origin() == dev.origin()) || url.as_str() == "about:blank"
}

#[tauri::command]
pub async fn worktree_file(state: tauri::State<'_, crate::state::State>, remotes: tauri::State<'_, std::sync::Arc<Remotes>>, repo: String, path: String) -> Result<Value, String> {
    state.listed(&repo)?;
    match remote::parse(&repo)? {
        Some(remote) => remote::ask(&remotes, &remote, json!({ "op": "worktreeFile", "path": path }), "repo").await,
        // Off the async runtime: up to 50 MB, from a share that may be slow.
        None => {
            let file = tauri::async_runtime::spawn_blocking(move || read_worktree_file(Path::new(&repo), &path)).await.map_err(|e| e.to_string())??;
            serde_json::to_value(file).map_err(|e| e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_diff_window_stays_on_the_apps_own_pages() {
        let url = |s: &str| tauri::Url::parse(s).unwrap();
        assert!(own_page(&url("tauri://localhost/diff.html"), None));
        let dev = url("http://localhost:1420/");
        assert!(own_page(&url("http://localhost:1420/diff.html"), Some(&dev)));
        for away in ["https://example.com/", "http://localhost:1420/diff.html", "smb://server/share", "file:///etc/hosts", "tauri://evil/diff.html"] {
            assert!(!own_page(&url(away), None), "{away}");
        }
    }
}
