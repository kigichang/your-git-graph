//! The one file the app writes into a work tree, as a Tauri command over `gg_backend::repo`:
//! on this Mac, or on the repository's machine (remote.rs).

use std::path::Path;
use std::sync::Arc;

use gg_backend::repo::write_repo_config;
use serde_json::{json, Value};

use crate::remote::{self, Remotes};

/// Where the file was written (a path on the repository's machine).
#[tauri::command]
pub async fn export_repo_config(state: tauri::State<'_, crate::state::State>, remotes: tauri::State<'_, Arc<Remotes>>, repo: String, contents: String) -> Result<Value, String> {
    state.listed(&repo)?;
    match remote::parse(&repo)? {
        Some(remote) => remote::ask(&remotes, &remote, json!({ "op": "exportRepoConfig", "contents": contents }), "repo").await,
        None => write_repo_config(Path::new(&repo), &contents).map(|f| json!(f.display().to_string())),
    }
}
