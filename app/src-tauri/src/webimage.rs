//! Images from the web in the Markdown preview (diff/main.js), fetched when the person asks for
//! them (the Load button). The page itself loads none: the CSP's `img-src` has no `http:` or
//! `https:`, so nothing a document holds - an `<img>`, a Mermaid diagram's image, a CSS `url()` -
//! tells a server who reads it and when, or knocks on this machine's own services, by itself.
//! The image comes back as a `data:` URL.

use std::process::Stdio;
use std::time::Duration;

use base64::Engine;
use tokio::io::AsyncReadExt;

const MAX_BYTES: usize = 20 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(30);
/// Fetches at a time: a document of many images waits its turn.
static RUNNING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
/// Where curl writes the content type, after whatever it says on stderr.
const TYPE_MARK: &str = "@@GG-TYPE@@";

/// The image at `url` (http or https only, redirects too) as a `data:` URL; at most 20 MiB, and
/// only what the server says is an image.
async fn fetch(curl: &str, url: &str) -> Result<String, String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(format!("Not loaded: {url} (only http and https images are)."));
    }
    let max = MAX_BYTES.to_string();
    let seconds = TIMEOUT.as_secs().to_string();
    let write_out = format!("%{{stderr}}\n{TYPE_MARK}%{{content_type}}");
    let mut child = tokio::process::Command::new(curl)
        // -q first: no ~/.curlrc. --globoff: `{a,b}` and `[1-9]` in a URL are not lists of URLs
        // (each fetched, all answers run together, only the last one's type seen).
        .args(["-q", "--silent", "--show-error", "--fail", "--globoff", "--location", "--max-redirs", "5"])
        .args(["--proto", "=http,https", "--proto-redir", "=http,https"])
        .args(["--max-time", &seconds, "--max-filesize", &max, "--write-out", &write_out, "--", url])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Cannot run curl: {e}"))?;
    let too_large = || format!("{url} is larger than {} MiB.", MAX_BYTES / 1024 / 1024);
    let (mut stdout, mut stderr) = (child.stdout.take().expect("piped"), child.stderr.take().expect("piped"));
    let said = tokio::spawn(async move {
        let mut said = Vec::new();
        let _ = stderr.read_to_end(&mut said).await;
        said
    });
    let read = async {
        // At most one byte past the limit: before 8.4, curl's --max-filesize lets a response
        // without a Content-Length run on (into memory here) until the time is up.
        let mut body = Vec::new();
        (&mut stdout).take(MAX_BYTES as u64 + 1).read_to_end(&mut body).await.map_err(|e| e.to_string())?;
        if body.len() > MAX_BYTES {
            return Err(too_large()); // curl is killed when dropped
        }
        let status = child.wait().await.map_err(|e| e.to_string())?;
        Ok((status, body))
    };
    let (status, body) = tokio::time::timeout(TIMEOUT + Duration::from_secs(5), read)
        .await
        .map_err(|_| format!("{url} did not answer within {} seconds.", TIMEOUT.as_secs()))??;
    let stderr = said.await.map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&stderr);
    let (said, content_type) = stderr.rsplit_once(TYPE_MARK).unwrap_or((&stderr, ""));
    if !status.success() {
        let said = said.trim();
        return Err(if said.is_empty() { format!("{url} could not be loaded ({status}).") } else { said.to_string() });
    }
    let mime = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if !mime.starts_with("image/") || mime.contains(|c: char| !(c.is_ascii_alphanumeric() || "/+.-".contains(c))) {
        return Err(format!("{url} is not an image ({}).", if mime.is_empty() { "no content type" } else { &mime }));
    }
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&body)))
}

/// An image from the web the person asked to load, as a `data:` URL.
#[tauri::command]
pub async fn fetch_image(url: String) -> Result<String, String> {
    let _turn = RUNNING.acquire().await.map_err(|e| e.to_string())?;
    fetch("/usr/bin/curl", &url).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A server answering each connection with `responses[i]` (status line, headers, body).
    fn serve(responses: Vec<Vec<u8>>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(&response);
            }
        });
        address
    }

    fn response(status: &str, content_type: &str, body: &[u8], extra: &str) -> Vec<u8> {
        let mut r = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n", body.len()).into_bytes();
        r.extend_from_slice(body);
        r
    }

    #[tokio::test]
    async fn an_image_comes_back_as_a_data_url() {
        let base = serve(vec![response("200 OK", "image/png; charset=binary", b"\x89PNG", "")]);
        assert_eq!(fetch("/usr/bin/curl", &format!("{base}/a.png")).await, Ok("data:image/png;base64,iVBORw==".to_string()));
    }

    #[tokio::test]
    async fn what_is_not_an_image_or_not_there_is_refused() {
        let base = serve(vec![response("200 OK", "text/html", b"<p>hi</p>", ""), response("404 Not Found", "image/png", b"", "")]);
        assert!(fetch("/usr/bin/curl", &format!("{base}/page")).await.unwrap_err().contains("not an image"));
        assert!(fetch("/usr/bin/curl", &format!("{base}/gone.png")).await.unwrap_err().contains("404"));
    }

    /// No Content-Length: the size is only known by reading, and reading stops past the limit (a
    /// curl since 8.4 stops itself).
    #[tokio::test]
    async fn an_image_too_large_is_refused_without_a_length() {
        let mut big = b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nConnection: close\r\n\r\n".to_vec();
        big.extend(std::iter::repeat_n(0u8, MAX_BYTES + 1024));
        let base = serve(vec![big]);
        let refused = fetch("/usr/bin/curl", &format!("{base}/big.png")).await.unwrap_err();
        assert!(refused.contains("larger than") || refused.contains("maximum allowed file size"), "{refused}");
    }

    /// A curl that writes on and on (as one before 8.4 does): stopped at the limit.
    #[tokio::test]
    async fn an_endless_answer_is_cut_off() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let curl = dir.path().join("curl");
        std::fs::write(&curl, "#!/bin/sh\nexec yes\n").unwrap();
        std::fs::set_permissions(&curl, std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = std::time::Instant::now();
        assert!(fetch(curl.to_str().unwrap(), "http://example.com/a.png").await.unwrap_err().contains("larger than"));
        assert!(started.elapsed() < TIMEOUT / 2, "took {:?}", started.elapsed());
    }

    /// `{a,b}` in a URL is one address, not two fetched in turn with only the last one's type
    /// checked: the first answer (not an image) would come back in front of the image.
    #[tokio::test]
    async fn braces_and_brackets_are_not_lists_of_urls() {
        let base = serve(vec![response("200 OK", "text/plain", b"secret", ""), response("200 OK", "image/png", b"\x89PNG", "")]);
        assert!(fetch("/usr/bin/curl", &format!("{base}/{{secret,a.png}}")).await.unwrap_err().contains("not an image"));
    }

    #[tokio::test]
    async fn only_http_and_https_even_after_a_redirect() {
        for url in ["file:///etc/hosts", "ftp://example.com/a.png", "-o/tmp/x", "javascript:1"] {
            assert!(fetch("/usr/bin/curl", url).await.unwrap_err().contains("only http and https"), "{url}");
        }
        let base = serve(vec![response("302 Found", "text/plain", b"", "Location: file:///etc/hosts\r\n")]);
        let refused = fetch("/usr/bin/curl", &format!("{base}/away")).await.unwrap_err();
        assert!(refused.to_lowercase().contains("protocol"), "{refused}");
    }
}
