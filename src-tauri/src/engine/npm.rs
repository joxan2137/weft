use std::error::Error as _;
use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;

use super::state::{ErrorKind, Failure, OrFail};

const REGISTRY: &str = "https://registry.npmjs.org";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Also bounds a stalled download: the timer restarts with every chunk that arrives.
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const PROXY_HINT: &str = " (Weft follows the Windows proxy setting; for a proxy found through a PAC script, set HTTPS_PROXY)";

#[derive(Deserialize)]
pub struct Dist {
    pub tarball: String,
    pub integrity: String,
}

#[derive(Deserialize)]
struct VersionDoc {
    dist: Dist,
}

#[derive(Deserialize)]
struct DistTags {
    latest: String,
}

#[cfg(target_arch = "x86_64")]
pub fn package() -> &'static str {
    if is_x86_feature_detected!("avx2") {
        "opencode-windows-x64"
    } else {
        "opencode-windows-x64-baseline"
    }
}

#[cfg(not(target_arch = "x86_64"))]
pub fn package() -> &'static str {
    "opencode-windows-arm64"
}

pub fn client() -> Result<Client, Failure> {
    Client::builder()
        .user_agent(concat!("weft/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .or_fail(ErrorKind::Resolve, "creating the HTTP client")
}

/// reqwest's own message hides the cause ("error sending request"), so the whole chain is kept.
pub fn failure(kind: ErrorKind, doing: &str, error: reqwest::Error) -> Failure {
    let mut message = format!("{doing}: {error}");
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    if error.is_connect() || error.is_timeout() {
        message.push_str(PROXY_HINT);
    }
    Failure::new(kind, message)
}

/// Reads `dist-tags.latest` through the dist-tags endpoint; the full packument is several MB.
pub async fn latest(client: &Client) -> Result<String, Failure> {
    let url = format!("{REGISTRY}/-/package/{}/dist-tags", package());
    let tags: DistTags = get_json(client, &url, ErrorKind::Resolve).await?;
    Ok(tags.latest)
}

pub async fn dist(client: &Client, version: &str) -> Result<Dist, Failure> {
    let url = format!("{REGISTRY}/{}/{version}", package());
    let doc: VersionDoc = get_json(client, &url, ErrorKind::Install).await?;
    Ok(doc.dist)
}

async fn get_json<T: for<'de> Deserialize<'de>>(
    client: &Client,
    url: &str,
    kind: ErrorKind,
) -> Result<T, Failure> {
    let doing = format!("fetching {url}");
    client
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| failure(kind, &doing, error))?
        .json()
        .await
        .map_err(|error| failure(kind, &doing, error))
}
