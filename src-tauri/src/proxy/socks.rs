use std::io;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use base64::Engine as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::{ParsedProxy, Scheme};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HEADER: usize = 16 * 1024;

pub struct Target {
    pub host: String,
    pub port: u16,
}

impl Target {
    pub fn authority(&self) -> String {
        if self.host.parse::<Ipv6Addr>().is_ok() {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

pub fn parse_target(target: &str) -> io::Result<Target> {
    let target = target.trim();
    if let Some(rest) = target.strip_prefix('[') {
        let (host, rest) = rest
            .split_once(']')
            .ok_or_else(|| invalid("a CONNECT target has no closing bracket"))?;
        let port = rest
            .strip_prefix(':')
            .ok_or_else(|| invalid("a CONNECT target has no port"))?;
        return target_with(host, port, target);
    }
    let (host, port) = target
        .rsplit_once(':')
        .ok_or_else(|| invalid("a CONNECT target has no port"))?;
    target_with(host, port, target)
}

fn target_with(host: &str, port: &str, original: &str) -> io::Result<Target> {
    let port = port
        .parse::<u16>()
        .map_err(|_| invalid(&format!("a CONNECT target has an invalid port: {original}")))?;
    if port == 0 || host.is_empty() || host.chars().any(char::is_whitespace) {
        return Err(invalid(&format!(
            "a CONNECT target is malformed: {original}"
        )));
    }
    Ok(Target {
        host: host.to_owned(),
        port,
    })
}

pub async fn connect(upstream: &ParsedProxy, target: &Target) -> io::Result<TcpStream> {
    tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        let stream = TcpStream::connect((upstream.host.as_str(), upstream.port)).await?;
        stream.set_nodelay(true)?;
        match upstream.scheme {
            Scheme::Socks4 => socks4(stream, upstream, target).await,
            Scheme::Socks5 => socks5(stream, upstream, target).await,
            Scheme::Http => http(stream, upstream, target).await,
        }
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "the proxy did not answer in time"))?
}

pub async fn direct(target: &Target) -> io::Result<TcpStream> {
    let stream = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        TcpStream::connect((target.host.as_str(), target.port)),
    )
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "the host did not answer in time"))??;
    stream.set_nodelay(true)?;
    Ok(stream)
}

async fn socks5(
    mut stream: TcpStream,
    upstream: &ParsedProxy,
    target: &Target,
) -> io::Result<TcpStream> {
    let auth = upstream
        .username
        .as_deref()
        .zip(upstream.password.as_deref());
    let methods: &[u8] = if auth.is_some() { &[0, 2] } else { &[0] };
    let mut greeting = vec![5, methods.len() as u8];
    greeting.extend_from_slice(methods);
    stream.write_all(&greeting).await?;

    let mut choice = [0u8; 2];
    stream.read_exact(&mut choice).await?;
    if choice[0] != 5 {
        return Err(invalid("the SOCKS5 proxy answered with another version"));
    }
    match choice[1] {
        0 => {}
        2 => {
            let Some((username, password)) = auth else {
                return Err(invalid(
                    "the SOCKS5 proxy wants credentials, none were given",
                ));
            };
            if username.len() > 255 || password.len() > 255 {
                return Err(invalid("the SOCKS5 proxy credentials are too long"));
            }
            let mut login = vec![1, username.len() as u8];
            login.extend_from_slice(username.as_bytes());
            login.push(password.len() as u8);
            login.extend_from_slice(password.as_bytes());
            stream.write_all(&login).await?;
            let mut answer = [0u8; 2];
            stream.read_exact(&mut answer).await?;
            if answer[1] != 0 {
                return Err(invalid("the SOCKS5 proxy refused the credentials"));
            }
        }
        0xff => return Err(invalid("the SOCKS5 proxy accepts none of our methods")),
        _ => return Err(invalid("the SOCKS5 proxy chose an unsupported method")),
    }

    let mut request = vec![5, 1, 0];
    push_address(&mut request, &target.host)?;
    request.extend_from_slice(&target.port.to_be_bytes());
    stream.write_all(&request).await?;

    let mut reply = [0u8; 4];
    stream.read_exact(&mut reply).await?;
    if reply[0] != 5 || reply[1] != 0 {
        return Err(invalid(&format!(
            "the SOCKS5 proxy refused the connection (code {})",
            reply[1]
        )));
    }
    skip_address(&mut stream, reply[3]).await?;
    Ok(stream)
}

fn push_address(out: &mut Vec<u8>, host: &str) -> io::Result<()> {
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        out.push(1);
        out.extend_from_slice(&ip.octets());
    } else if let Ok(ip) = host.parse::<Ipv6Addr>() {
        out.push(4);
        out.extend_from_slice(&ip.octets());
    } else {
        if host.len() > 255 {
            return Err(invalid("the SOCKS target hostname is too long"));
        }
        out.push(3);
        out.push(host.len() as u8);
        out.extend_from_slice(host.as_bytes());
    }
    Ok(())
}

async fn skip_address(stream: &mut TcpStream, kind: u8) -> io::Result<()> {
    let length = match kind {
        1 => 4,
        4 => 16,
        3 => {
            let mut length = [0u8; 1];
            stream.read_exact(&mut length).await?;
            length[0] as usize
        }
        _ => return Err(invalid("the SOCKS5 proxy sent an unknown address type")),
    };
    let mut skip = vec![0u8; length + 2];
    stream.read_exact(&mut skip).await?;
    Ok(())
}

async fn socks4(
    mut stream: TcpStream,
    upstream: &ParsedProxy,
    target: &Target,
) -> io::Result<TcpStream> {
    let userid = upstream.username.as_deref().unwrap_or("");
    if userid.len() > 255 {
        return Err(invalid("the SOCKS4 user id is too long"));
    }
    let mut request = vec![4, 1];
    request.extend_from_slice(&target.port.to_be_bytes());
    if let Ok(ip) = target.host.parse::<Ipv4Addr>() {
        request.extend_from_slice(&ip.octets());
        request.extend_from_slice(userid.as_bytes());
        request.push(0);
    } else {
        request.extend_from_slice(&[0, 0, 0, 1]);
        request.extend_from_slice(userid.as_bytes());
        request.push(0);
        request.extend_from_slice(target.host.as_bytes());
        request.push(0);
    }
    stream.write_all(&request).await?;

    let mut reply = [0u8; 8];
    stream.read_exact(&mut reply).await?;
    if reply[1] != 90 {
        return Err(invalid(&format!(
            "the SOCKS4 proxy refused the connection (code {})",
            reply[1]
        )));
    }
    Ok(stream)
}

async fn http(
    mut stream: TcpStream,
    upstream: &ParsedProxy,
    target: &Target,
) -> io::Result<TcpStream> {
    let authority = target.authority();
    let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let (Some(username), Some(password)) =
        (upstream.username.as_deref(), upstream.password.as_deref())
    {
        request.push_str(&format!(
            "Proxy-Authorization: Basic {}\r\n",
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"))
        ));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await?;

    let mut head = Vec::with_capacity(512);
    let mut chunk = [0u8; 512];
    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(invalid("the HTTP proxy closed the connection"));
        }
        head.extend_from_slice(&chunk[..read]);
        if head.len() > MAX_HEADER {
            return Err(invalid("the HTTP proxy sent a header that is too large"));
        }
    }
    let head = String::from_utf8_lossy(&head);
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| invalid("the HTTP proxy sent no status"))?;
    if !(200..300).contains(&status) {
        return Err(invalid(&format!(
            "the HTTP proxy refused the tunnel (HTTP {status})"
        )));
    }
    Ok(stream)
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hostname_and_ipv6_targets() {
        let target = parse_target("opencode.ai:443").unwrap();
        assert_eq!((target.host.as_str(), target.port), ("opencode.ai", 443));
        assert_eq!(target.authority(), "opencode.ai:443");

        let target = parse_target("[::1]:8443").unwrap();
        assert_eq!((target.host.as_str(), target.port), ("::1", 8443));
        assert_eq!(target.authority(), "[::1]:8443");

        assert!(parse_target("opencode.ai").is_err());
        assert!(parse_target("opencode.ai:0").is_err());
        assert!(parse_target(":443").is_err());
        assert!(parse_target("[::1]").is_err());
    }
}
