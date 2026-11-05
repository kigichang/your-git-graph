//! What the app does to a repository, without Tauri: the engine call, the git CLI, the files
//! read and written outside git, and the file watcher. The app calls these for local
//! repositories; the remote helper (crates/remote) serves the same over ssh.

pub mod files;
pub mod git;
pub mod repo;
pub mod watch;
pub mod wire;

/// One engine call: `{"method", "params"}` in, the method's JSON answer out. Failures ride
/// in-band as `{"error": "Kind: message"}`.
pub fn engine(repo: &str, request: &str) -> String {
    git_graph_core::dispatch::request(repo, request)
}
