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

/// Redirects followed, one request each: every hop's address is checked.
const MAX_REDIRECTS: usize = 5;
/// What is kept of what curl says (an error line, the marks below).
const MAX_SAID: u64 = 64 * 1024;
/// Where curl writes the address a redirect points to, after the content type.
const NEXT_MARK: &str = "\n@@GG-NEXT@@";

/// Addresses no document may have the app ask: this machine (loopback, unspecified) and its own
/// link (link-local, where a cloud machine's metadata service answers; multicast, broadcast). A
/// page's document would otherwise reach the services that listen only here. Private networks
/// are not refused: an organisation's own git server is on one, and so are its documents' images.
fn forbidden(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(a) => a.is_loopback() || a.is_link_local() || a.is_unspecified() || a.is_multicast() || a.is_broadcast(),
        std::net::IpAddr::V6(a) => match a.to_ipv4_mapped() {
            Some(v4) => forbidden(std::net::IpAddr::V4(v4)),
            None => a.is_loopback() || a.is_unspecified() || a.is_multicast() || a.segments()[0] & 0xffc0 == 0xfe80,
        },
    }
}

enum Answer {
    Image(String),
    Moved(String),
}

/// The image at `url` (http or https only, redirects too) as a `data:` URL; at most 20 MiB, and
/// only what the server says is an image. Not from this machine itself ([`forbidden`]) unless
/// `local` (the tests' servers).
async fn fetch(curl: &str, url: &str, local: bool) -> Result<String, String> {
    let hops = async {
        let mut at = url.to_string();
        for _ in 0..=MAX_REDIRECTS {
            match hop(curl, &at, local).await? {
                Answer::Image(data) => return Ok(data),
                Answer::Moved(next) => at = next,
            }
        }
        Err(format!("{url} redirects more than {MAX_REDIRECTS} times."))
    };
    tokio::time::timeout(TIMEOUT + Duration::from_secs(5), hops).await.map_err(|_| format!("{url} did not answer within {} seconds.", TIMEOUT.as_secs()))?
}

/// One request: the image, or where the server sends us instead. The name is resolved here and
/// curl is held to that address (`--resolve`), so what was checked is what is asked.
async fn hop(curl: &str, url: &str, local: bool) -> Result<Answer, String> {
    let parsed = tauri::Url::parse(url)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some())
        .ok_or_else(|| format!("Not loaded: {url} (only http and https images are)."))?;
    let addresses = {
        let parsed = parsed.clone();
        tokio::task::spawn_blocking(move || parsed.socket_addrs(|| None)).await.map_err(|e| e.to_string())?.map_err(|e| format!("{url}: {e}"))?
    };
    let Some(address) = addresses.first() else { return Err(format!("{url}: no address.")) };
    if !local && addresses.iter().any(|a| forbidden(a.ip())) {
        return Err(format!("Not loaded: {url} (an address of this machine itself)."));
    }
    let pinned = parsed.domain().map(|name| match address.ip() {
        std::net::IpAddr::V4(ip) => format!("{name}:{}:{ip}", address.port()),
        std::net::IpAddr::V6(ip) => format!("{name}:{}:[{ip}]", address.port()),
    });
    let max = MAX_BYTES.to_string();
    let seconds = TIMEOUT.as_secs().to_string();
    let write_out = format!("%{{stderr}}\n{TYPE_MARK}%{{content_type}}{NEXT_MARK}%{{redirect_url}}");
    let mut command = tokio::process::Command::new(curl);
    // -q first: no ~/.curlrc. --globoff: `{a,b}` and `[1-9]` in a URL are not lists of URLs
    // (each fetched, all answers run together, only the last one's type seen).
    command.args(["-q", "--silent", "--show-error", "--fail", "--globoff", "--proto", "=http,https"]);
    if let Some(pinned) = &pinned {
        command.args(["--resolve", pinned]);
    }
    let mut child = command
        .args(["--max-time", &seconds, "--max-filesize", &max, "--write-out", &write_out, "--", parsed.as_str()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Cannot run curl: {e}"))?;
    let (mut stdout, mut stderr) = (child.stdout.take().expect("piped"), child.stderr.take().expect("piped"));
    let said = tokio::spawn(async move {
        let mut said = Vec::new();
        let _ = (&mut stderr).take(MAX_SAID).read_to_end(&mut said).await;
        let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await; // curl is not left waiting
        said
    });
    // At most one byte past the limit: before 8.4, curl's --max-filesize lets a response
    // without a Content-Length run on (into memory here) until the time is up.
    let mut body = Vec::new();
    (&mut stdout).take(MAX_BYTES as u64 + 1).read_to_end(&mut body).await.map_err(|e| e.to_string())?;
    if body.len() > MAX_BYTES {
        return Err(format!("{url} is larger than {} MiB.", MAX_BYTES / 1024 / 1024)); // curl is killed when dropped
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = said.await.map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&stderr);
    let (said, marks) = stderr.rsplit_once(TYPE_MARK).unwrap_or((&stderr, ""));
    let (content_type, next) = marks.split_once(NEXT_MARK).unwrap_or((marks, ""));
    if !status.success() {
        let said = said.trim();
        return Err(if said.is_empty() { format!("{url} could not be loaded ({status}).") } else { said.to_string() });
    }
    if !next.trim().is_empty() {
        return Ok(Answer::Moved(next.trim().to_string()));
    }
    let mime = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if !mime.starts_with("image/") || mime.contains(|c: char| !(c.is_ascii_alphanumeric() || "/+.-".contains(c))) {
        return Err(format!("{url} is not an image ({}).", if mime.is_empty() { "no content type" } else { &mime }));
    }
    Ok(Answer::Image(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&body))))
}

/// An image from the web the person asked to load, as a `data:` URL.
#[tauri::command]
pub async fn fetch_image(url: String) -> Result<String, String> {
    let _turn = RUNNING.acquire().await.map_err(|e| e.to_string())?;
    fetch("/usr/bin/curl", &url, false).await
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
        assert_eq!(fetch("/usr/bin/curl", &format!("{base}/a.png"), true).await, Ok("data:image/png;base64,iVBORw==".to_string()));
    }

    #[tokio::test]
    async fn what_is_not_an_image_or_not_there_is_refused() {
        let base = serve(vec![response("200 OK", "text/html", b"<p>hi</p>", ""), response("404 Not Found", "image/png", b"", "")]);
        assert!(fetch("/usr/bin/curl", &format!("{base}/page"), true).await.unwrap_err().contains("not an image"));
        assert!(fetch("/usr/bin/curl", &format!("{base}/gone.png"), true).await.unwrap_err().contains("404"));
    }

    /// No Content-Length: the size is only known by reading, and reading stops past the limit (a
    /// curl since 8.4 stops itself).
    #[tokio::test]
    async fn an_image_too_large_is_refused_without_a_length() {
        let mut big = b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nConnection: close\r\n\r\n".to_vec();
        big.extend(std::iter::repeat_n(0u8, MAX_BYTES + 1024));
        let base = serve(vec![big]);
        let refused = fetch("/usr/bin/curl", &format!("{base}/big.png"), true).await.unwrap_err();
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
        assert!(fetch(curl.to_str().unwrap(), "http://127.0.0.1/a.png", true).await.unwrap_err().contains("larger than"));
        assert!(started.elapsed() < TIMEOUT / 2, "took {:?}", started.elapsed());
    }

    #[tokio::test]
    async fn only_http_and_https_even_after_a_redirect() {
        for url in ["file:///etc/hosts", "ftp://example.com/a.png", "-o/tmp/x", "javascript:1"] {
            assert!(fetch("/usr/bin/curl", url, true).await.unwrap_err().contains("only http and https"), "{url}");
        }
        let base = serve(vec![response("302 Found", "text/plain", b"", "Location: file:///etc/hosts\r\n")]);
        let refused = fetch("/usr/bin/curl", &format!("{base}/away"), true).await.unwrap_err();
        assert!(refused.contains("only http and https"), "{refused}");
    }

    /// Each hop is a request of its own, to an address that was checked.
    #[tokio::test]
    async fn a_redirect_is_followed_hop_by_hop() {
        let base = serve(vec![response("302 Found", "text/plain", b"moved", "Location: /b.png\r\n"), response("200 OK", "image/png", b"\x89PNG", "")]);
        assert_eq!(fetch("/usr/bin/curl", &format!("{base}/a.png"), true).await, Ok("data:image/png;base64,iVBORw==".to_string()));
        let around: Vec<Vec<u8>> = (0..=MAX_REDIRECTS).map(|_| response("302 Found", "text/plain", b"", "Location: /again\r\n")).collect();
        let base = serve(around);
        assert!(fetch("/usr/bin/curl", &format!("{base}/again"), true).await.unwrap_err().contains("redirects more than"));
    }

    /// `{a,b}` in a URL is one address, not two fetched in turn with only the last one's type
    /// checked: the first answer (not an image) would come back in front of the image.
    #[tokio::test]
    async fn braces_and_brackets_are_not_lists_of_urls() {
        let base = serve(vec![response("200 OK", "text/plain", b"secret", ""), response("200 OK", "image/png", b"\x89PNG", "")]);
        assert!(fetch("/usr/bin/curl", &format!("{base}/{{secret,a.png}}"), true).await.unwrap_err().contains("not an image"));
    }

    /// Nothing is asked of this machine itself, by address or by name, nor of its link.
    #[tokio::test]
    async fn this_machine_is_not_asked() {
        let base = serve(vec![response("200 OK", "image/png", b"\x89PNG", "")]);
        for url in [format!("{base}/a.png"), "http://localhost:9/a.png".into(), "http://[::1]:9/a.png".into(), "http://169.254.169.254/latest".into(), "http://0.0.0.0/a.png".into()] {
            assert!(fetch("/usr/bin/curl", &url, false).await.unwrap_err().contains("this machine itself"), "{url}");
        }
        let ip = |s: &str| s.parse::<std::net::IpAddr>().unwrap();
        assert!(["127.0.0.1", "::1", "::ffff:127.0.0.1", "fe80::1", "169.254.1.1", "0.0.0.0", "224.0.0.1"].iter().all(|a| forbidden(ip(a))));
        assert!(["93.184.216.34", "10.0.0.1", "192.168.1.1", "2606:2800:220:1::1"].iter().all(|a| !forbidden(ip(a))));
    }
}
