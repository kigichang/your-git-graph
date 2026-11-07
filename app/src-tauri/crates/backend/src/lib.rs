//! What the app does to a repository, without Tauri: the engine call, the git CLI, the files
//! read and written outside git, the file watcher, and the askpass program's side. The app calls these for local
//! repositories; the remote helper (crates/remote) serves the same over ssh.

pub mod api;
pub mod askpass;
pub mod files;
pub mod git;
pub mod graph;
pub mod loss;
pub mod ops;
pub mod reads;
pub mod repo;
pub mod runtime;
pub mod settings;
pub mod watch;
pub mod wire;

/// One engine call: `{"method", "params"}` in, the method's JSON answer out. Failures ride
/// in-band as `{"error": "Kind: message"}`.
pub fn engine(repo: &str, request: &str) -> String {
    git_graph_core::dispatch::request(repo, request)
}
