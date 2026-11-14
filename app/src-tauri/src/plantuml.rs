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
use tokio::io::AsyncWriteExt;

/// The setting holding the path of plantuml.jar.
pub const JAR_SETTING: &str = "plantuml.jar";
const TIMEOUT: Duration = Duration::from_secs(30);
const CACHE_LIMIT: usize = 64;
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
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Cannot run {}: {e}", java.display()))?;
    let mut stdin = child.stdin.take().expect("piped");
    let source = with_start_end(code);
    let run = async {
        // Written while the output is read: a large diagram fills neither pipe.
        let write = async {
            let _ = stdin.write_all(source.as_bytes()).await;
            drop(stdin);
        };
        let (_, output) = tokio::join!(write, child.wait_with_output());
        output
    };
    let output = match tokio::time::timeout(timeout, run).await {
        Err(_) => return Err(format!("PlantUML did not finish within {} seconds.", timeout.as_secs())),
        Ok(Err(e)) => return Err(e.to_string()),
        Ok(Ok(output)) => output,
    };
    // A syntax error is drawn as a diagram too: only no SVG at all means the run failed.
    let svg = String::from_utf8_lossy(&output.stdout);
    if svg.contains("<svg") {
        Ok(svg.into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() { format!("PlantUML produced no diagram ({}).", output.status) } else { stderr })
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
    if cache.len() >= CACHE_LIMIT {
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
        let none = render(Path::new("/nonexistent/java"), &jar, "A -> B", Duration::from_secs(10)).await.unwrap_err();
        assert!(none.contains("Cannot run"), "{none}");
    }
}
