//! PlantUML diagrams of the Markdown preview (diff/main.js). PlantUML is a Java program: the
//! diagram's source is piped through the `plantuml.jar` named in settings.json (the setting
//! `plantuml.jar`) on this Mac, also for a repository on another machine.
//! Nothing is sent to a PlantUML server. Without the setting nothing is rendered.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The setting holding the path of plantuml.jar.
pub const JAR_SETTING: &str = "plantuml.jar";
const TIMEOUT: Duration = Duration::from_secs(30);
const CACHE_LIMIT: usize = 64;
/// What the cache holds at most, all diagrams together.
const CACHE_BYTES: usize = 64 * 1024 * 1024;
/// A drawing larger than this is given up (a preprocessor loop can write without end).
const MAX_SVG: usize = 16 * 1024 * 1024;
/// What is kept of what java says when it fails.
const MAX_SAID: u64 = 64 * 1024;
/// A diagram's source longer than this is not drawn.
const MAX_SOURCE: usize = 256 * 1024;
/// JVMs at a time: a document of many diagrams (all asked for at once) waits its turn instead of
/// starting a JVM for each.
const AT_ONCE: usize = 2;
static RUNNING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(AT_ONCE);

/// Rendered diagrams by (jar, source): a JVM start per diagram is slow, and the same file is
/// opened again and again.
#[derive(Default)]
pub struct Cache(Mutex<HashMap<u64, String>>);

/// A java binary, by absolute path: an app started from the Finder has only the system
/// directories on its PATH, and `java_home` knows only the JDKs registered in
/// /Library/Java/JavaVirtualMachines - not Homebrew's keg-only openjdk.
/// `GG_PLANTUML_JAVA` (tests, development) is used as it is.
fn find_java() -> Option<PathBuf> {
    if let Some(java) = std::env::var_os("GG_PLANTUML_JAVA") {
        return Some(PathBuf::from(java));
    }
    let file = |p: PathBuf| p.is_file().then_some(p);
    if let Some(java) = std::env::var_os("JAVA_HOME").and_then(|home| file(PathBuf::from(home).join("bin/java"))) {
        return Some(java);
    }
    // Fails quietly without a registered JDK (it never brings up the "install Java" dialog).
    if let Ok(out) = std::process::Command::new("/usr/libexec/java_home").stdin(Stdio::null()).output() {
        if out.status.success() {
            let home = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Some(java) = file(PathBuf::from(home).join("bin/java")) {
                return Some(java);
            }
        }
    }
    for prefix in ["/opt/homebrew/opt", "/usr/local/opt"] {
        if let Some(java) = file(PathBuf::from(prefix).join("openjdk/bin/java")) {
            return Some(java);
        }
        // Versioned kegs (openjdk@21): the highest name.
        let mut kegs: Vec<PathBuf> = std::fs::read_dir(prefix)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("openjdk"))
            .map(|e| e.path().join("bin/java"))
            .filter(|p| p.is_file())
            .collect();
        kegs.sort();
        if let Some(java) = kegs.pop() {
            return Some(java);
        }
    }
    std::env::var_os("PATH").and_then(|path| std::env::split_paths(&path).find_map(|dir| file(dir.join("java"))))
}

/// A block of a Markdown file is usually just the diagram's body.
fn with_start_end(code: &str) -> String {
    if code.contains("@start") {
        code.to_string()
    } else {
        format!("@startuml\n{}\n@enduml\n", code.trim_end())
    }
}

/// The SVG of `code`, by `java -jar <jar> -pipe`. The source comes from a repository, so
/// PlantUML runs in its SANDBOX profile: `!include` and the like read no files and no URLs.
async fn render(java: &Path, jar: &Path, code: &str, timeout: Duration) -> Result<String, String> {
    if !jar.is_file() {
        return Err(format!("plantuml.jar not found: {} (\"{JAR_SETTING}\" in settings.json).", jar.display()));
    }
    let mut child = tokio::process::Command::new(java)
        .arg("-Djava.awt.headless=true")
        .arg("-DPLANTUML_SECURITY_PROFILE=SANDBOX")
        .arg("-jar")
        .arg(jar)
        .args(["-pipe", "-tsvg", "-charset", "UTF-8"])
        .env("PLANTUML_SECURITY_PROFILE", "SANDBOX")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0) // with whatever it starts (Graphviz's dot), to end them together
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Cannot run {}: {e}", java.display()))?;
    let _group = child.id().map(Group);
    let (mut stdin, mut stdout, mut stderr) = (child.stdin.take().expect("piped"), child.stdout.take().expect("piped"), child.stderr.take().expect("piped"));
    let source = with_start_end(code);
    let run = async {
        // Written while the output is read: a large diagram fills neither pipe.
        let write = async {
            let _ = stdin.write_all(source.as_bytes()).await;
            drop(stdin);
        };
        let said = async {
            let mut said = Vec::new();
            let _ = (&mut stderr).take(MAX_SAID).read_to_end(&mut said).await;
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await; // java is not left waiting
            said
        };
        // At most one byte past the limit: java is ended (the group, below) rather than read on.
        let drawn = async {
            let mut svg = Vec::new();
            (&mut stdout).take(MAX_SVG as u64 + 1).read_to_end(&mut svg).await.map(|_| svg)
        };
        // The drawing decides: past the limit nothing waits for java to stop talking.
        let rest = async { tokio::join!(write, said).1 };
        tokio::pin!(rest, drawn);
        let mut heard = None;
        let svg = loop {
            tokio::select! {
                svg = &mut drawn => break svg.map_err(|e| e.to_string())?,
                said = &mut rest, if heard.is_none() => heard = Some(said),
            }
        };
        if svg.len() > MAX_SVG {
            return Err(format!("The diagram's drawing is too large (more than {} MiB).", MAX_SVG / 1024 / 1024));
        }
        let said = match heard {
            Some(said) => said,
            None => rest.await,
        };
        let status = child.wait().await.map_err(|e| e.to_string())?;
        Ok((status, svg, said))
    };
    let (status, svg, said) = match tokio::time::timeout(timeout, run).await {
        Err(_) => return Err(format!("PlantUML did not finish within {} seconds.", timeout.as_secs())),
        Ok(result) => result?,
    };
    // A syntax error is drawn as a diagram too: only no SVG at all means the run failed.
    let svg = String::from_utf8_lossy(&svg);
    if svg.contains("<svg") {
        Ok(svg.into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&said).trim().to_string();
        Err(if stderr.is_empty() { format!("PlantUML produced no diagram ({status}).") } else { stderr })
    }
}

/// java's process group, killed when the run is over however it ended: a timeout or a drawing
/// too large leaves no child of it (dot) behind. After a normal end there is nobody left in it.
struct Group(u32);

impl Drop for Group {
    fn drop(&mut self) {
        // SAFETY: killpg only sends a signal; the group is the one this run created.
        unsafe {
            libc::killpg(self.0 as libc::pid_t, libc::SIGKILL);
        }
    }
}

/// The jar the settings name, or why there is none.
fn jar_of(setting: Option<&str>) -> Result<PathBuf, String> {
    match setting.map(str::trim) {
        Some(path) if !path.is_empty() => Ok(PathBuf::from(path)),
        _ => Err(format!("PlantUML is not set up: set \"{JAR_SETTING}\" in settings.json to the path of plantuml.jar.")),
    }
}

/// The SVG of a PlantUML diagram of the Markdown preview.
#[tauri::command]
pub async fn render_plantuml(app: AppHandle, cache: tauri::State<'_, Cache>, code: String) -> Result<String, String> {
    if code.len() > MAX_SOURCE {
        return Err(format!("The diagram is too long to draw ({} KiB; at most {} KiB).", code.len() / 1024, MAX_SOURCE / 1024));
    }
    let jar = jar_of(crate::settings::load(&crate::state::settings_file(&app)?)?.settings.plantuml_jar.as_deref())?;
    let key = {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        (&jar, &code).hash(&mut hasher);
        hasher.finish()
    };
    if let Some(svg) = cache.0.lock().unwrap().get(&key) {
        return Ok(svg.clone());
    }
    let java = find_java().ok_or("Java not found: PlantUML needs a JDK (for example `brew install openjdk`).")?;
    let _turn = RUNNING.acquire().await.map_err(|e| e.to_string())?;
    // Drawn meanwhile by another request for the same diagram.
    if let Some(svg) = cache.0.lock().unwrap().get(&key) {
        return Ok(svg.clone());
    }
    let svg = render(&java, &jar, &code, TIMEOUT).await?;
    let mut cache = cache.0.lock().unwrap();
    if cache.len() >= CACHE_LIMIT || cache.values().map(String::len).sum::<usize>() + svg.len() > CACHE_BYTES {
        cache.clear();
    }
    cache.insert(key, svg.clone());
    Ok(svg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_java() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fake-java.sh")
    }

    #[test]
    fn the_jar_comes_from_the_settings() {
        assert_eq!(jar_of(Some(" /opt/plantuml.jar ")).unwrap(), PathBuf::from("/opt/plantuml.jar"));
        for none in [None, Some(""), Some("  ")] {
            assert!(jar_of(none).unwrap_err().contains(JAR_SETTING));
        }
    }

    #[test]
    fn a_bare_diagram_is_wrapped() {
        assert_eq!(with_start_end("A -> B\n"), "@startuml\nA -> B\n@enduml\n");
        assert_eq!(with_start_end("@startmindmap\n* a\n@endmindmap"), "@startmindmap\n* a\n@endmindmap");
    }

    #[tokio::test]
    async fn renders_through_the_jar_in_the_sandbox_profile() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("plant uml.jar");
        std::fs::write(&jar, b"").unwrap();
        // The stand-in for java answers with an SVG holding its arguments and its input.
        let svg = render(&fake_java(), &jar, "A -> B", Duration::from_secs(10)).await.unwrap();
        assert!(svg.contains("<svg"), "{svg}");
        assert!(svg.contains("-DPLANTUML_SECURITY_PROFILE=SANDBOX"), "{svg}");
        assert!(svg.contains(&format!("-jar {} -pipe -tsvg -charset UTF-8", jar.display())), "{svg}");
        assert!(svg.contains("@startuml") && svg.contains("A -&gt; B") && svg.contains("@enduml"), "{svg}");
    }

    #[tokio::test]
    async fn failures_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let missing = render(&fake_java(), &dir.path().join("none.jar"), "A -> B", Duration::from_secs(10)).await.unwrap_err();
        assert!(missing.contains("not found") && missing.contains(JAR_SETTING), "{missing}");
        let jar = dir.path().join("plantuml.jar");
        std::fs::write(&jar, b"").unwrap();
        // The stand-in fails like java does on a broken jar ...
        let failed = render(&fake_java(), &jar, "gg-fake-fail", Duration::from_secs(10)).await.unwrap_err();
        assert!(failed.contains("Invalid or corrupt jarfile"), "{failed}");
        // ... and hangs on request: the run is given up and the process killed.
        let started = std::time::Instant::now();
        let slow = render(&fake_java(), &jar, "gg-fake-hang", Duration::from_millis(300)).await.unwrap_err();
        assert!(slow.contains("did not finish") && started.elapsed() < Duration::from_secs(5), "{slow}");
        // ... and one that draws without end is cut off at the limit, not read into memory.
        let endless = dir.path().join("java");
        std::fs::write(&endless, "#!/bin/sh\ncat > /dev/null\nexec yes '<svg>'\n").unwrap();
        std::fs::set_permissions(&endless, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let large = render(&endless, &jar, "A -> B", Duration::from_secs(20)).await.unwrap_err();
        assert!(large.contains("too large"), "{large}");
        let none = render(Path::new("/nonexistent/java"), &jar, "A -> B", Duration::from_secs(10)).await.unwrap_err();
        assert!(none.contains("Cannot run"), "{none}");
    }
}
