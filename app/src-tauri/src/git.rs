//! The `git` this Mac runs (git_info), and the questions a git on another machine asks,
//! shown in the window that started the operation (api.rs routes them here).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use gg_backend::git::{locate_git, GitInfo};

use crate::remote::Session;

/// Show a question of the git on another machine in `window` and send the answer back.
pub fn remote_prompt(session: &Arc<Session>, prompts: &Arc<crate::askpass::Askpass>, window: &str, asked: &Arc<Mutex<HashMap<u64, u64>>>, ask: u64, prompt: String) {
    let waiting = prompts.prompt(window, prompt);
    if let Some((id, _)) = &waiting {
        asked.lock().unwrap().insert(ask, *id);
    }
    let (session, prompts, window, asked) = (session.clone(), prompts.clone(), window.to_string(), asked.clone());
    tauri::async_runtime::spawn(async move {
        let answer = match waiting {
            None => None, // the window is gone
            Some((id, answered)) => tauri::async_runtime::spawn_blocking(move || {
                let answer = answered.recv_timeout(crate::askpass::ANSWER_TIMEOUT).ok().flatten();
                prompts.close(&window, id); // unanswered in time: take it down
                answer
            })
            .await
            .ok()
            .flatten(),
        };
        asked.lock().unwrap().remove(&ask);
        let _ = session.json(serde_json::json!({ "op": "answer", "ask": ask, "answer": answer })).await;
    });
}

/// The git the app runs, or why there is none.
#[tauri::command]
pub fn git_info() -> Result<GitInfo, String> {
    locate_git().cloned()
}
