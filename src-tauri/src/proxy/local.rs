use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

use super::*;

const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BODY: usize = 8 * 1024;

struct Request {
    method: String,
    target: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

pub(crate) async fn serve(listener: TcpListener, inner: Arc<Inner>) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tauri::async_runtime::spawn(handle(stream, inner.clone()));
            }
            Err(error) => {
                applog::line("proxy", format!("accept failed: {error}"));
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

async fn handle(mut stream: TcpStream, inner: Arc<Inner>) {
    let Ok(Ok(request)) = tokio::time::timeout(HEADER_TIMEOUT, read_request(&mut stream)).await
    else {
        return;
    };
    if request.target == "/__weft/report" {
        let _ = report(&mut stream, &request, &inner).await;
        return;
    }
    if !request.method.eq_ignore_ascii_case("CONNECT") {
        let _ = respond(
            &mut stream,
            501,
            "Not Implemented",
            "Weft's local proxy only carries CONNECT tunnels.\n",
        )
        .await;
        return;
    }
    let target = match socks::parse_target(&request.target) {
        Ok(target) => target,
        Err(error) => {
            let _ = respond(&mut stream, 400, "Bad Request", &format!("{error}\n")).await;
            return;
        }
    };

    let token = proxy_token(&request.headers);
    let selected = if is_zen(&target.host) {
        inner.select(token.as_deref())
    } else {
        Some(inner.plain())
    };
    let Some(selected) = selected else {
        inner.spawn_refresh(true);
        let _ = respond(
            &mut stream,
            502,
            "Bad Gateway",
            "Weft is still looking for a working proxy.\n",
        )
        .await;
        return;
    };
    let leased = selected.entry.clone();

    let mut attempts = Vec::new();
    if let Some(current) = selected.entry.clone() {
        attempts.push(Attempt {
            upstream: selected.upstream.clone(),
            entry: Some(current.clone()),
        });
        let mut seen = HashSet::from([current.clone()]);
        for entry in inner.alternatives(&current, token.as_deref(), 2) {
            if seen.insert(entry.url.clone()) {
                attempts.push(Attempt {
                    upstream: Upstream::Proxy(entry.proxy),
                    entry: Some(entry.url),
                });
            }
        }
    } else {
        attempts.push(Attempt {
            upstream: selected.upstream,
            entry: None,
        });
    }

    let mut tunnel = None;
    for attempt in attempts {
        let connected = match &attempt.upstream {
            Upstream::Direct => socks::direct(&target).await,
            Upstream::Proxy(proxy) => socks::connect(proxy, &target).await,
        };
        match connected {
            Ok(upstream) => {
                tunnel = Some((upstream, attempt));
                break;
            }
            Err(error) => {
                if let Some(url) = &attempt.entry {
                    inner.report_unstable(url);
                }
                applog::line("proxy", format!("{} failed: {error}", target.authority()));
            }
        }
    }

    let Some((mut upstream, attempt)) = tunnel else {
        let _ = respond(
            &mut stream,
            502,
            "Bad Gateway",
            "Every proxy for this request failed.\n",
        )
        .await;
        return;
    };
    if let (Some(token), Some(url)) = (token.as_deref(), attempt.entry.as_deref())
        && leased.as_deref() != Some(url)
    {
        inner.bind_token(token, url);
    }
    if stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .is_err()
    {
        return;
    }
    let mut closing = inner.closing.subscribe();
    let closed = async {
        let Some(url) = &attempt.entry else {
            return std::future::pending().await;
        };
        loop {
            match closing.recv().await {
                Ok(Closing::Exit(gone)) if &gone == url => return,
                Ok(Closing::Token(gone)) if token.as_deref() == Some(gone.as_str()) => return,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    return std::future::pending().await;
                }
                _ => {}
            }
        }
    };
    tokio::select! {
        copied = tokio::io::copy_bidirectional(&mut stream, &mut upstream) => {
            if copied.is_ok()
                && let Some(url) = &attempt.entry
            {
                inner.report_good(url);
            }
        }
        () = closed => {}
    }
}

struct Attempt {
    upstream: Upstream,
    entry: Option<String>,
}

async fn read_request(stream: &mut TcpStream) -> io::Result<Request> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).await? == 0 {
        return Err(invalid("the client closed before sending a request"));
    }
    let mut parts = line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| invalid("the request line has no method"))?
        .to_owned();
    let target = parts
        .next()
        .ok_or_else(|| invalid("the request line has no target"))?
        .to_owned();

    let mut headers = HashMap::new();
    let mut total = line.len();
    loop {
        line.clear();
        if reader.read_line(&mut line).await? == 0 {
            return Err(invalid("the client closed inside the headers"));
        }
        total += line.len();
        if total > 32 * 1024 {
            return Err(invalid("the request headers are too large"));
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        headers.insert(
            name.trim().to_ascii_lowercase(),
            value.trim().trim_end_matches(['\r', '\n']).to_owned(),
        );
    }

    let length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if length > MAX_BODY {
        return Err(invalid("the request body is too large"));
    }
    let mut body = vec![0u8; length];
    if length > 0 {
        reader.read_exact(&mut body).await?;
    }
    Ok(Request {
        method,
        target,
        headers,
        body,
    })
}

#[derive(Deserialize)]
struct Report {
    token: String,
    #[serde(default)]
    reason: Option<String>,
}

async fn report(stream: &mut TcpStream, request: &Request, inner: &Arc<Inner>) -> io::Result<()> {
    if !request.method.eq_ignore_ascii_case("POST") {
        return respond(stream, 405, "Method Not Allowed", "POST only.\n").await;
    }
    let allowed = request
        .headers
        .get("x-weft-control")
        .is_some_and(|value| value == &inner.control);
    if !allowed {
        return respond(stream, 403, "Forbidden", "Bad control token.\n").await;
    }
    let Ok(report) = serde_json::from_slice::<Report>(&request.body) else {
        return respond(stream, 400, "Bad Request", "Invalid report.\n").await;
    };
    if report.token.is_empty() || report.token.len() > 128 {
        return respond(stream, 400, "Bad Request", "Invalid token.\n").await;
    }
    let reason = report.reason.as_deref().unwrap_or("proxy report");
    inner.report_token(&report.token, &reason.chars().take(200).collect::<String>());
    respond(stream, 200, "OK", "{}").await
}

async fn respond(stream: &mut TcpStream, code: u16, reason: &str, body: &str) -> io::Result<()> {
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.shutdown().await
}

fn proxy_token(headers: &HashMap<String, String>) -> Option<String> {
    let value = headers.get("proxy-authorization")?;
    let token = if value
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("Basic "))
    {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(value[6..].trim())
            .ok()?;
        let decoded = String::from_utf8_lossy(&decoded);
        decoded.split(':').next()?.to_owned()
    } else {
        let token = value.strip_prefix("Weft ")?;
        token.trim().to_owned()
    };
    (!token.is_empty() && token.len() <= 128).then_some(token)
}

fn is_zen(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "opencode.ai" || host.ends_with(".opencode.ai")
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::RwLock;

    #[tokio::test]
    async fn tunnels_plain_connect_targets_directly() {
        let origin = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let origin_port = origin.local_addr().unwrap().port();
        let origin_task = tokio::spawn(async move {
            let (mut socket, _) = origin.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).await;
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
                )
                .await
                .unwrap();
        });

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let inner = Arc::new(Inner {
            settings: RwLock::new(ProxySettings::default()),
            pool: RwLock::new(PoolState::default()),
            scan: Mutex::new(ScanState::default()),
            tokens: Mutex::new(Tokens::default()),
            refreshing: AtomicBool::new(false),
            client: reqwest::Client::new(),
            fallback: None,
            control: "test".into(),
            closing: tokio::sync::broadcast::channel(64).0,
            listener: tokio::sync::Mutex::new(None),
        });
        let proxy_task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            handle(stream, inner).await;
        });

        let mut client = TcpStream::connect(address).await.unwrap();
        client
            .write_all(
                format!("CONNECT 127.0.0.1:{origin_port} HTTP/1.1\r\nHost: 127.0.0.1:{origin_port}\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        let mut head = [0u8; 128];
        let read = tokio::time::timeout(Duration::from_secs(2), client.read(&mut head))
            .await
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&head[..read]).starts_with("HTTP/1.1 200"));

        client
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        client.shutdown().await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), client.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&response).contains("hello"));
        proxy_task.await.unwrap();
        origin_task.await.unwrap();
    }
}
