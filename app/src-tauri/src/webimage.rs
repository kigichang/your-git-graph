//! Images from the web in the Markdown preview (diff/main.js), fetched when the person asks for
//! them (the Load button). The page itself loads none: the CSP's `img-src` has no `http:` or
//! `https:`, so nothing a document holds - an `<img>`, a Mermaid diagram's image, a CSS `url()` -
//! tells a server who reads it and when, or knocks on this machine's own services, by itself.
//! The image comes back as a `data:` URL.

use std::process::Stdio;
use std::time::Duration;

use base64::Engine;

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
    let child = tokio::process::Command::new(curl)
        // -q first: no ~/.curlrc.
        .args(["-q", "--silent", "--show-error", "--fail", "--location", "--max-redirs", "5"])
        .args(["--proto", "=http,https", "--proto-redir", "=http,https"])
        .args(["--max-time", &seconds, "--max-filesize", &max, "--write-out", &write_out, "--", url])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Cannot run curl: {e}"))?;
    let output = tokio::time::timeout(TIMEOUT + Duration::from_secs(5), child.wait_with_output())
        .await
        .map_err(|_| format!("{url} did not answer within {} seconds.", TIMEOUT.as_secs()))?
        .map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let (said, content_type) = stderr.rsplit_once(TYPE_MARK).unwrap_or((&stderr, ""));
    if !output.status.success() {
        let said = said.trim();
        return Err(if said.is_empty() { format!("{url} could not be loaded ({}).", output.status) } else { said.to_string() });
    }
    let mime = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if !mime.starts_with("image/") || mime.contains(|c: char| !(c.is_ascii_alphanumeric() || "/+.-".contains(c))) {
        return Err(format!("{url} is not an image ({}).", if mime.is_empty() { "no content type" } else { &mime }));
    }
    if output.stdout.len() > MAX_BYTES {
        return Err(format!("{url} is larger than {} MiB.", MAX_BYTES / 1024 / 1024));
    }
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&output.stdout)))
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
