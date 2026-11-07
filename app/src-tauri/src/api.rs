//! The typed commands the front end calls for a repository (`gg_backend::api`). A local
//! repository is served here, off the main thread; one on another machine by its helper, which
//! runs the same code.

use std::sync::Arc;

use gg_backend::api::{ReadRequest, ReadResponse};
use serde_json::json;

use crate::remote::{self, Remotes};

#[tauri::command]
pub async fn repo_read(remotes: tauri::State<'_, Arc<Remotes>>, repo: String, request: ReadRequest) -> Result<ReadResponse, String> {
    if let Some(remote) = remote::parse(&repo)? {
        let answer = remote::ask(&remotes, &remote, json!({ "op": "read", "request": request }), "repo").await?;
        return serde_json::from_value(answer).map_err(|e| e.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || gg_backend::api::read(&repo, request))
        .await
        .map_err(|e| e.to_string())?
}
