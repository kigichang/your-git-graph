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
    tauri_build::build()
}
