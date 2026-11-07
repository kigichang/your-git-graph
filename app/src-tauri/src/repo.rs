//! Repository state the engine does not report (an operation in progress) and the one file the
//! app writes into a work tree, as Tauri commands over `gg_backend::repo` - on this Mac, or on
//! the repository's machine (remote.rs).

use std::path::Path;
use std::sync::Arc;

use gg_backend::repo::{operation_state, write_repo_config};
use serde_json::{json, Value};

use crate::remote::{self, Remotes};

#[tauri::command]
pub async fn repo_operation_state(state: tauri::State<'_, crate::state::State>, remotes: tauri::State<'_, Arc<Remotes>>, repo: String) -> Result<Value, String> {
    state.listed(&repo)?;
    match remote::parse(&repo)? {
        Some(remote) => remote::ask(&remotes, &remote, json!({ "op": "operationState" }), "repo").await,
        None => serde_json::to_value(operation_state(Path::new(&repo))).map_err(|e| e.to_string()),
    }
}

/// Where the file was written (a path on the repository's machine).
#[tauri::command]
pub async fn export_repo_config(state: tauri::State<'_, crate::state::State>, remotes: tauri::State<'_, Arc<Remotes>>, repo: String, contents: String) -> Result<Value, String> {
    state.listed(&repo)?;
    match remote::parse(&repo)? {
        Some(remote) => remote::ask(&remotes, &remote, json!({ "op": "exportRepoConfig", "contents": contents }), "repo").await,
        None => write_repo_config(Path::new(&repo), &contents).map(|f| json!(f.display().to_string())),
    }
}
