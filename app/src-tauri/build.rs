/// Every command of `generate_handler!` in src/main.rs.
const COMMANDS: &[&str] = &[
    "initial_repo",
    "repo_read",
    "repo_op",
    "repo_op_cancel",
    "trust_filters",
    "engine_request",
    "host_log",
    "self_test",
    "selftest_write",
    "preview",
    "preview_resize",
    "export_repo_config",
    "clipboard_write",
    "open_url",
    "open_repo_file",
    "reveal_repo",
    "open_terminal",
    "mount_volume",
    "network_volume",
    "askpass_reply",
    "remote_connect",
    "remote_disconnect",
    "open_diff_window",
    "worktree_file",
    "render_plantuml",
    "fetch_image",
    "scan_repos",
    "recent_repos",
    "repo_opened",
    "open_new_window",
    "set_appearance",
    "state_snapshot",
    "state_set",
    "settings_get",
    "settings_set",
    "open_settings_file",
    "open_session_log",
];

fn main() {
    // The remote helpers are built by scripts/build-remote.sh into remote-dist/ (remote.rs
    // embeds them). A build without them still compiles: an empty placeholder means "this build
    // has no helper for that platform".
    let dist = std::path::Path::new("remote-dist");
    let _ = std::fs::create_dir_all(dist);
    for platform in ["linux-x86_64", "linux-aarch64", "darwin-arm64"] {
        for extension in ["id", "gz"] {
            let file = dist.join(format!("{platform}.{extension}"));
            if !file.exists() {
                let _ = std::fs::write(&file, b"");
            }
        }
    }
    println!("cargo:rerun-if-changed=remote-dist");
    // Listed here, a command is only open to the windows whose capability names it
    // (capabilities/); unlisted, it is open to all. main.rs has a test that none is missing.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS))).expect("error while building the capabilities");
}
