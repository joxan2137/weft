mod local;
mod scan;
mod socks;

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::applog;
use crate::settings::{self, ProxyPatch, ProxySettings};

const SOURCES: [(&str, Scheme); 8] = [
    (
        "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt",
        Scheme::Socks5,
    ),
    (
        "https://raw.githubusercontent.com/xyzs996/free-proxy-health-list/main/socks5.txt",
        Scheme::Socks5,
    ),
    (
        "https://api.proxyscrape.com/?request=getproxies&proxytype=socks4",
        Scheme::Socks4,
    ),
    (
        "https://api.proxyscrape.com/?request=getproxies&proxytype=socks5",
        Scheme::Socks5,
    ),
    (
        "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt",
        Scheme::Socks5,
    ),
    (
        "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS4_RAW.txt",
        Scheme::Socks4,
    ),
    (
        "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt",
        Scheme::Socks4,
    ),
    (
        "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
        Scheme::Socks5,
    ),
];
const HEALTH_URL: &str = "https://opencode.ai/";
const ZEN_CHAT_URL: &str = "https://opencode.ai/zen/v1/chat/completions";
const ZEN_PROBE_MODEL: &str = "big-pickle";
const ZEN_FREE_TIER_ERROR: &str = "FreeTierError";
const GEO_LOOKUP_URL: &str = "http://ip-api.com/json";
const CANDIDATE_LIMIT: usize = 1_000;
const WORKING_TARGET: usize = 30;
const PROBE_CONCURRENCY: usize = 64;
const POOL_SIZE: usize = 25;
const RESCAN_THRESHOLD: usize = 13;
const STRIKE_LIMIT: u32 = 2;
const BLOCKED_COUNTRIES: [&str; 1] = ["CN"];
const HEALTH_TIMEOUT: Duration = Duration::from_secs(3);
const ZEN_TIMEOUT: Duration = Duration::from_secs(5);
const REFRESH_DEBOUNCE: Duration = Duration::from_secs(60);
const TOKEN_TTL: Duration = Duration::from_secs(10 * 60);
const TOKEN_LIMIT: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scheme {
    Socks4,
    Socks5,
    Http,
}

impl Scheme {
    fn prefix(self) -> &'static str {
        match self {
            Self::Socks4 => "socks4",
            Self::Socks5 => "socks5",
            Self::Http => "http",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ParsedProxy {
    pub scheme: Scheme,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl ParsedProxy {
    pub fn url(&self) -> String {
        let auth = match (&self.username, &self.password) {
            (Some(username), Some(password)) => {
                format!("{}:{}@", encode(username), encode(password))
            }
            (Some(username), None) => format!("{}@", encode(username)),
            _ => String::new(),
        };
        format!("{}://{}{}", self.scheme.prefix(), auth, self.authority())
    }

    fn authority(&self) -> String {
        if self.host.parse::<Ipv6Addr>().is_ok() {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    fn probe_url(&self) -> String {
        let auth = match (&self.username, &self.password) {
            (Some(username), Some(password)) => {
                format!("{}:{}@", encode(username), encode(password))
            }
            (Some(username), None) => format!("{}@", encode(username)),
            _ => String::new(),
        };
        let scheme = match self.scheme {
            Scheme::Socks5 => "socks5h",
            Scheme::Socks4 => "socks4a",
            Scheme::Http => "http",
        };
        format!("{scheme}://{auth}{}", self.authority())
    }

    pub fn masked(&self) -> String {
        match &self.username {
            Some(username) => format!("{}:{}:***", self.authority(), username),
            None => self.authority(),
        }
    }
}

fn encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let Some(hex) = bytes.get(index + 1..index + 3)
            && hex.iter().all(u8::is_ascii_hexdigit)
        {
            let hex = std::str::from_utf8(hex).unwrap_or_default();
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn split_scheme(input: &str) -> (Option<Scheme>, &str) {
    let trimmed = input.trim();
    let schemes = [
        ("socks4a://", Scheme::Socks4),
        ("socks4://", Scheme::Socks4),
        ("socks5h://", Scheme::Socks5),
        ("socks5://", Scheme::Socks5),
        ("socks://", Scheme::Socks5),
        ("http://", Scheme::Http),
    ];
    for (prefix, scheme) in schemes {
        if trimmed
            .get(..prefix.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
        {
            return (Some(scheme), &trimmed[prefix.len()..]);
        }
    }
    (None, trimmed)
}

pub fn parse_proxy(input: &str) -> Result<ParsedProxy, String> {
    if input
        .trim()
        .get(..8)
        .is_some_and(|start| start.eq_ignore_ascii_case("https://"))
    {
        return Err(format!(
            "Weft cannot reach a proxy over TLS, enter it as http:// instead: {}",
            masked_input(input)
        ));
    }
    let (scheme, stripped) = address_part(input);
    if stripped.is_empty() {
        return Err("a SOCKS proxy needs a host and port".into());
    }
    let scheme = scheme.unwrap_or(Scheme::Socks5);
    if let Some((auth, suffix)) = stripped.rsplit_once('@')
        && let Some(parsed) = endpoint(suffix, input)
    {
        let parsed = parsed?;
        let (username, password) = match auth.split_once(':') {
            Some((username, password)) => (decode(username), Some(decode(password))),
            None => (decode(auth), None),
        };
        if username.is_empty() || password.as_deref().is_some_and(str::is_empty) {
            return Err(format!(
                "the proxy credentials are incomplete: {}",
                masked_input(input)
            ));
        }
        return Ok(ParsedProxy {
            scheme,
            username: Some(username),
            password,
            ..parsed
        });
    }

    if let Some(rest) = stripped.strip_prefix('[') {
        let malformed = || format!("the proxy address is malformed: {}", masked_input(input));
        let (host, rest) = rest.split_once(']').ok_or_else(malformed)?;
        let rest = rest.strip_prefix(':').ok_or_else(malformed)?;
        let (port, credentials) = match rest.split_once(':') {
            Some((port, credentials)) => (port, Some(credentials)),
            None => (rest, None),
        };
        let parsed = host_port(host, port, input)?;
        let Some(credentials) = credentials else {
            return Ok(ParsedProxy { scheme, ..parsed });
        };
        let (username, password) = credentials.split_once(':').ok_or_else(malformed)?;
        return Ok(ParsedProxy {
            scheme,
            username: Some(username.to_owned()),
            password: Some(password.to_owned()),
            ..parsed
        });
    }

    let parts: Vec<&str> = stripped.split(':').collect();
    if parts.len() == 2 {
        return Ok(ParsedProxy {
            scheme,
            ..host_port(parts[0], parts[1], input)?
        });
    }
    if parts.len() >= 4 {
        return Ok(ParsedProxy {
            scheme,
            username: Some(parts[2].to_owned()),
            password: Some(parts[3..].join(":")),
            ..host_port(parts[0], parts[1], input)?
        });
    }
    Err(format!(
        "the proxy address needs host:port or host:port:login:password: {}",
        masked_input(input)
    ))
}

fn address_part(input: &str) -> (Option<Scheme>, &str) {
    let (scheme, rest) = split_scheme(input);
    let rest = match scheme {
        Some(_) => rest.split('/').next().unwrap_or(""),
        None => rest.trim_end_matches('/'),
    };
    (scheme, rest.trim())
}

fn endpoint(suffix: &str, input: &str) -> Option<Result<ParsedProxy, String>> {
    let (host, port) = match suffix.strip_prefix('[') {
        Some(rest) => rest.split_once("]:")?,
        None => suffix.split_once(':').filter(|(_, port)| !port.contains(':'))?,
    };
    if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(host_port(host, port, input))
}

fn host_port(host: &str, port: &str, input: &str) -> Result<ParsedProxy, String> {
    if host.is_empty() || host.chars().any(char::is_whitespace) {
        return Err(format!(
            "the proxy host is malformed: {}",
            masked_input(input)
        ));
    }
    let port = port
        .parse::<u16>()
        .map_err(|_| format!("the proxy port is malformed: {}", masked_input(input)))?;
    if port == 0 {
        return Err(format!(
            "the proxy port is malformed: {}",
            masked_input(input)
        ));
    }
    Ok(ParsedProxy {
        scheme: Scheme::Socks5,
        host: host.to_owned(),
        port,
        username: None,
        password: None,
    })
}

fn masked_input(input: &str) -> String {
    let (_, stripped) = address_part(input);
    match stripped.rsplit_once('@') {
        Some((_, host)) => format!("***@{host}"),
        None => stripped.to_owned(),
    }
}

fn probe_candidate(line: &str, default: Scheme) -> Option<String> {
    let (scheme, _) = split_scheme(line);
    if matches!(scheme, Some(Scheme::Http)) {
        return None;
    }
    let proxy = parse_proxy(line).ok()?;
    if proxy.host.parse::<Ipv4Addr>().is_err() || proxy.username.is_some() {
        return None;
    }
    Some(
        ParsedProxy {
            scheme: scheme.unwrap_or(default),
            ..proxy
        }
        .url(),
    )
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub url: String,
    pub latency_ms: u64,
    pub country: Option<String>,
    pub country_code: Option<String>,
    pub proxy: ParsedProxy,
}

impl Entry {
    fn masked(&self) -> String {
        self.proxy.masked()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub tested: usize,
    pub working: usize,
    pub failed: usize,
    pub transport: usize,
    pub status: usize,
    pub quota: usize,
    pub slow: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub source: &'static str,
    pub count: usize,
    pub has_custom: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_country: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_country_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fastest_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slowest_ms: Option<u64>,
    pub refreshing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rescan_cooldown_ms: Option<u64>,
    pub max_latency_ms: u64,
    pub scan_total: usize,
    pub scan_tested: usize,
    pub scan_working: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_scan: Option<ScanSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_scan_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) enum Upstream {
    Direct,
    Proxy(ParsedProxy),
}

pub(crate) struct Selected {
    pub upstream: Upstream,
    pub entry: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Geo {
    pub country: String,
    pub country_code: String,
}

pub(crate) struct PoolState {
    pub entries: Vec<Entry>,
    pub cursor: usize,
    pub strikes: HashMap<String, u32>,
    pub evicted: HashSet<String>,
    pub country_cache: HashMap<String, Geo>,
    pub blocked: HashSet<String>,
    pub last_refresh: Option<Instant>,
}

impl Default for PoolState {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            cursor: 0,
            strikes: HashMap::new(),
            evicted: HashSet::new(),
            country_cache: HashMap::new(),
            blocked: BLOCKED_COUNTRIES.into_iter().map(str::to_owned).collect(),
            last_refresh: None,
        }
    }
}

#[derive(Default)]
pub(crate) struct ScanState {
    pub total: usize,
    pub tested: usize,
    pub working: usize,
    pub last: Option<ScanSummary>,
    pub last_at: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Default)]
pub(crate) struct Tokens {
    map: HashMap<String, (String, Instant)>,
}

impl Tokens {
    fn entry(&mut self, token: &str) -> Option<String> {
        let now = Instant::now();
        if self
            .map
            .get(token)
            .is_some_and(|(_, at)| now.duration_since(*at) >= TOKEN_TTL)
        {
            self.map.remove(token);
        }
        self.map.get_mut(token).map(|(url, at)| {
            *at = now;
            url.clone()
        })
    }

    fn assigned(&self, except: &str) -> HashSet<String> {
        let now = Instant::now();
        self.map
            .iter()
            .filter(|(token, (_, at))| {
                token.as_str() != except && now.duration_since(*at) < TOKEN_TTL
            })
            .map(|(_, (url, _))| url.clone())
            .collect()
    }

    fn insert(&mut self, token: &str, url: String) {
        let now = Instant::now();
        self.map
            .retain(|_, (_, at)| now.duration_since(*at) < TOKEN_TTL);
        if !self.map.contains_key(token)
            && self.map.len() >= TOKEN_LIMIT
            && let Some(oldest) = self
                .map
                .iter()
                .min_by_key(|(_, (_, at))| *at)
                .map(|(token, _)| token.clone())
        {
            self.map.remove(&oldest);
        }
        self.map.insert(token.to_owned(), (url, now));
    }

    fn remove(&mut self, token: &str) -> Option<String> {
        self.map.remove(token).map(|(url, _)| url)
    }
}

pub(crate) struct Inner {
    pub settings: RwLock<ProxySettings>,
    pub pool: RwLock<PoolState>,
    pub scan: Mutex<ScanState>,
    pub tokens: Mutex<Tokens>,
    pub refreshing: AtomicBool,
    pub client: reqwest::Client,
    pub fallback: Option<ParsedProxy>,
    pub control: String,
    pub closing: tokio::sync::broadcast::Sender<Closing>,
    listener: tokio::sync::Mutex<Option<Listener>>,
}

#[derive(Clone)]
pub(crate) enum Closing {
    Exit(String),
    Token(String),
}

struct Listener {
    port: u16,
    task: JoinHandle<()>,
}

pub struct Proxy {
    inner: Arc<Inner>,
}

impl Default for Proxy {
    fn default() -> Self {
        Self::new()
    }
}

impl Proxy {
    pub fn new() -> Self {
        let fallback = fallback_proxy();
        let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(20));
        if let Some(proxy) = &fallback
            && let Ok(configured) = reqwest::Proxy::all(proxy.probe_url())
        {
            builder = builder.proxy(configured);
        }
        let client = builder.build().unwrap_or_else(|_| reqwest::Client::new());
        Self {
            inner: Arc::new(Inner {
                settings: RwLock::new(ProxySettings::default()),
                pool: RwLock::new(PoolState::default()),
                scan: Mutex::new(ScanState::default()),
                tokens: Mutex::new(Tokens::default()),
                refreshing: AtomicBool::new(false),
                client,
                fallback,
                control: uuid::Uuid::new_v4().to_string(),
                listener: tokio::sync::Mutex::new(None),
            closing: tokio::sync::broadcast::channel(64).0,
            }),
        }
    }

    pub async fn boot(&self, app: &AppHandle) {
        let settings = settings::load_proxy(app);
        *write(&self.inner.settings) = settings.clone();
        if !settings.enabled {
            return;
        }
        self.ensure_listener().await;
        if settings.custom.is_none() {
            self.inner.spawn_refresh(false);
        }
    }

    pub async fn stop(&self) {
        if let Some(listener) = self.inner.listener.lock().await.take() {
            listener.task.abort();
        }
    }

    pub fn status(&self) -> Status {
        let settings = read(&self.inner.settings).clone();
        let pool = read(&self.inner.pool);
        let scan = lock(&self.inner.scan);
        let count = if settings.custom.is_some() {
            1
        } else {
            pool.entries.len()
        };
        let current = if settings.custom.is_some() {
            settings
                .custom
                .as_deref()
                .and_then(|custom| parse_proxy(custom).ok().map(|proxy| proxy.masked()))
        } else if pool.entries.is_empty() {
            None
        } else {
            Some(pool.entries[pool.cursor % pool.entries.len()].masked())
        };
        let current_entry = if settings.custom.is_some() || pool.entries.is_empty() {
            None
        } else {
            Some(&pool.entries[pool.cursor % pool.entries.len()])
        };
        let latencies = pool.entries.iter().map(|entry| entry.latency_ms);
        let cooldown = if self.inner.refreshing.load(Ordering::SeqCst) {
            None
        } else {
            pool.last_refresh
                .map(|at| REFRESH_DEBOUNCE.saturating_sub(at.elapsed()).as_millis() as u64)
        };
        Status {
            enabled: settings.enabled,
            source: if !settings.enabled {
                "none"
            } else if settings.custom.is_some() {
                "custom"
            } else if pool.entries.is_empty() {
                "none"
            } else {
                "pool"
            },
            count: if settings.enabled { count } else { 0 },
            has_custom: settings.custom.is_some(),
            custom: settings
                .custom
                .as_deref()
                .and_then(|custom| parse_proxy(custom).ok().map(|proxy| proxy.masked())),
            current,
            current_latency_ms: current_entry.map(|entry| entry.latency_ms),
            current_country: current_entry.and_then(|entry| entry.country.clone()),
            current_country_code: current_entry.and_then(|entry| entry.country_code.clone()),
            fastest_ms: latencies.clone().min(),
            slowest_ms: latencies.max(),
            refreshing: settings.custom.is_none() && self.inner.refreshing.load(Ordering::SeqCst),
            rescan_cooldown_ms: if settings.custom.is_none() {
                cooldown
            } else {
                None
            },
            max_latency_ms: settings.max_latency_ms,
            scan_total: scan.total,
            scan_tested: scan.tested,
            scan_working: scan.working,
            last_scan: scan.last.clone(),
            last_scan_at: scan.last_at,
            last_error: if settings.custom.is_some() {
                None
            } else {
                scan.last_error.clone()
            },
        }
    }

    pub async fn engine_env(&self, app: &AppHandle) -> Vec<(&'static str, OsString)> {
        let settings = settings::load_proxy(app);
        *write(&self.inner.settings) = settings.clone();
        if !settings.enabled {
            self.stop().await;
            return Vec::new();
        }
        let Some(port) = self.ensure_listener().await else {
            return Vec::new();
        };
        if settings.custom.is_none() && read(&self.inner.pool).entries.is_empty() {
            self.inner.spawn_refresh(true);
        }
        let url = format!("http://127.0.0.1:{port}");
        let no_proxy = no_proxy_value();
        let mut env = vec![
            ("HTTPS_PROXY", url.clone().into()),
            ("https_proxy", url.clone().into()),
            ("NO_PROXY", no_proxy.clone().into()),
            ("no_proxy", no_proxy.into()),
        ];
        // The plugin exists to rotate tokens across the pool. A custom proxy is a single exit, so
        // the engine talks to the local proxy directly and the plugin stays idle.
        if settings.custom.is_none() {
            env.push(("WEFT_PROXY_URL", url.into()));
            env.push(("WEFT_PROXY_CONTROL", self.inner.control.clone().into()));
        }
        env
    }

    pub async fn set_enabled(&self, app: &AppHandle, enabled: bool) -> Result<Status, String> {
        let settings = settings::update_proxy(
            app,
            ProxyPatch {
                enabled: Some(enabled),
                ..Default::default()
            },
        )?;
        *write(&self.inner.settings) = settings.clone();
        if enabled {
            self.ensure_listener().await;
            if settings.custom.is_none() {
                self.inner.spawn_refresh(true);
            }
        } else {
            self.stop().await;
            let mut pool = write(&self.inner.pool);
            pool.entries.clear();
            pool.cursor = 0;
            pool.strikes.clear();
        }
        Ok(self.status())
    }

    pub async fn set_custom(
        &self,
        app: &AppHandle,
        custom: Option<String>,
    ) -> Result<Status, String> {
        let custom = match custom {
            Some(custom) if !custom.trim().is_empty() => Some(
                parse_proxy(&custom)
                    .map_err(|error| error.to_string())?
                    .url(),
            ),
            _ => None,
        };
        let settings = settings::update_proxy(
            app,
            ProxyPatch {
                enabled: custom.is_some().then_some(true),
                custom: Some(custom),
                ..Default::default()
            },
        )?;
        *write(&self.inner.settings) = settings.clone();
        if settings.enabled {
            self.ensure_listener().await;
            if settings.custom.is_some() {
                lock(&self.inner.scan).last_error = None;
            } else {
                self.inner.spawn_refresh(true);
            }
        }
        Ok(self.status())
    }

    pub async fn set_max_latency(
        &self,
        app: &AppHandle,
        max_latency_ms: u64,
    ) -> Result<Status, String> {
        if max_latency_ms == 0 || max_latency_ms > 600_000 {
            return Err("the latency cap must be between 1 and 600000 ms".into());
        }
        let settings = settings::update_proxy(
            app,
            ProxyPatch {
                max_latency_ms: Some(max_latency_ms),
                ..Default::default()
            },
        )?;
        *write(&self.inner.settings) = settings.clone();
        let mut pool = write(&self.inner.pool);
        pool.entries
            .retain(|entry| entry.latency_ms <= max_latency_ms);
        if pool.cursor >= pool.entries.len() {
            pool.cursor = 0;
        }
        drop(pool);
        lock(&self.inner.scan).last_error = None;
        Ok(self.status())
    }

    pub fn refresh(&self) {
        self.inner.spawn_refresh(true);
    }

    async fn ensure_listener(&self) -> Option<u16> {
        let mut slot = self.inner.listener.lock().await;
        if let Some(listener) = slot.as_ref()
            && !listener.task.is_finished()
        {
            return Some(listener.port);
        }
        slot.take();
        let listener = match TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(listener) => listener,
            Err(error) => {
                let message = format!("cannot listen on 127.0.0.1: {error}");
                lock(&self.inner.scan).last_error = Some(message.clone());
                applog::line("proxy", message);
                return None;
            }
        };
        let port = match listener.local_addr() {
            Ok(address) => address.port(),
            Err(error) => {
                let message = format!("cannot read the proxy address: {error}");
                lock(&self.inner.scan).last_error = Some(message.clone());
                applog::line("proxy", message);
                return None;
            }
        };
        let task = tokio::spawn(local::serve(listener, self.inner.clone()));
        *slot = Some(Listener { port, task });
        applog::line("proxy", format!("listening on 127.0.0.1:{port}"));
        Some(port)
    }
}

impl Inner {
    pub(crate) fn select(&self, token: Option<&str>) -> Option<Selected> {
        let settings = read(&self.settings).clone();
        if !settings.enabled {
            return Some(Selected {
                upstream: Upstream::Direct,
                entry: None,
            });
        }
        if let Some(custom) = settings.custom.as_deref()
            && let Ok(proxy) = parse_proxy(custom)
        {
            return Some(Selected {
                upstream: Upstream::Proxy(proxy),
                entry: None,
            });
        }
        let mut pool = write(&self.pool);
        if pool.entries.is_empty() {
            return None;
        }
        let index = match token {
            Some(token) => {
                let mut tokens = lock(&self.tokens);
                match tokens.entry(token) {
                    Some(url) => pool
                        .entries
                        .iter()
                        .position(|entry| entry.url == url)
                        .unwrap_or_else(|| reserve(&mut pool, &mut tokens, token)),
                    None => reserve(&mut pool, &mut tokens, token),
                }
            }
            None => {
                let index = pool.cursor % pool.entries.len();
                pool.cursor = (pool.cursor + 1) % pool.entries.len();
                index
            }
        };
        let entry = pool.entries[index].clone();
        Some(Selected {
            upstream: Upstream::Proxy(entry.proxy.clone()),
            entry: Some(entry.url),
        })
    }

    pub(crate) fn plain(&self) -> Selected {
        match &self.fallback {
            Some(proxy) => Selected {
                upstream: Upstream::Proxy(proxy.clone()),
                entry: None,
            },
            None => Selected {
                upstream: Upstream::Direct,
                entry: None,
            },
        }
    }

    pub(crate) fn alternatives(
        &self,
        exclude: &str,
        token: Option<&str>,
        count: usize,
    ) -> Vec<Entry> {
        let pool = read(&self.pool);
        let leased = match token {
            Some(token) => lock(&self.tokens).assigned(token),
            None => HashSet::new(),
        };
        let (busy, free): (Vec<Entry>, Vec<Entry>) = pool
            .entries
            .iter()
            .filter(|entry| entry.url != exclude)
            .cloned()
            .partition(|entry| leased.contains(&entry.url));
        free.into_iter().chain(busy).take(count).collect()
    }

    pub(crate) fn bind_token(&self, token: &str, url: &str) {
        let _ = self.closing.send(Closing::Token(token.to_owned()));
        lock(&self.tokens).insert(token, url.to_owned());
    }

    pub(crate) fn report_good(self: &Arc<Self>, url: &str) {
        write(&self.pool).strikes.remove(url);
    }

    pub(crate) fn report_unstable(self: &Arc<Self>, url: &str) {
        let evict = {
            let mut pool = write(&self.pool);
            let strikes = pool.strikes.entry(url.to_owned()).or_insert(0);
            *strikes += 1;
            if *strikes >= STRIKE_LIMIT {
                pool.strikes.remove(url);
                true
            } else {
                false
            }
        };
        if evict {
            self.evict(url, "transport failed twice in a row");
        }
    }

    pub(crate) fn report_token(self: &Arc<Self>, token: &str, reason: &str) {
        let url = lock(&self.tokens).remove(token);
        let _ = self.closing.send(Closing::Token(token.to_owned()));
        if let Some(url) = url {
            self.evict(&url, reason);
        }
    }

    fn evict(self: &Arc<Self>, url: &str, reason: &str) {
        let remaining = {
            let mut pool = write(&self.pool);
            let before = pool.entries.len();
            pool.entries.retain(|entry| entry.url != url);
            if pool.cursor >= pool.entries.len() {
                pool.cursor = 0;
            }
            if pool.entries.len() == before {
                return;
            }
            pool.evicted.insert(url.to_owned());
            pool.entries.len()
        };
        let _ = self.closing.send(Closing::Exit(url.to_owned()));
        applog::line(
            "proxy",
            format!("evicted {} ({reason}), {remaining} left", mask_url(url)),
        );
        if remaining < RESCAN_THRESHOLD {
            self.spawn_refresh(false);
        }
    }

    pub(crate) fn spawn_refresh(self: &Arc<Self>, force: bool) {
        let settings = read(&self.settings).clone();
        if !settings.enabled || settings.custom.is_some() {
            return;
        }
        if self.refreshing.swap(true, Ordering::SeqCst) {
            return;
        }
        if !force
            && let Some(last) = read(&self.pool).last_refresh
            && last.elapsed() < REFRESH_DEBOUNCE
        {
            self.refreshing.store(false, Ordering::SeqCst);
            return;
        }
        let inner = self.clone();
        tauri::async_runtime::spawn(scan::run(inner));
    }
}

fn reserve(pool: &mut PoolState, tokens: &mut Tokens, token: &str) -> usize {
    let leased = tokens.assigned(token);
    let len = pool.entries.len();
    let index = (0..len)
        .map(|step| (pool.cursor + step) % len)
        .find(|index| !leased.contains(&pool.entries[*index].url))
        .unwrap_or(pool.cursor % len);
    pool.cursor = (index + 1) % len;
    tokens.insert(token, pool.entries[index].url.clone());
    index
}

fn mask_url(url: &str) -> String {
    parse_proxy(url)
        .map(|proxy| proxy.masked())
        .unwrap_or_else(|_| "invalid-proxy".into())
}

fn fallback_proxy() -> Option<ParsedProxy> {
    ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
        .into_iter()
        .find_map(|key| std::env::var(key).ok())
        .and_then(|value| parse_proxy(&value).ok())
}

fn no_proxy_value() -> String {
    let raw = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .unwrap_or_default();
    no_proxy_from(&raw)
}

fn no_proxy_from(raw: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for part in raw.split([',', ' ', '\t', '\n', '\r']) {
        let part = part.trim();
        if part.is_empty() || part == "*" || bypasses_zen(part) {
            continue;
        }
        if !parts.iter().any(|kept| kept.eq_ignore_ascii_case(part)) {
            parts.push(part.to_owned());
        }
    }
    for local in ["localhost", "127.0.0.1", "::1"] {
        if !parts.iter().any(|part| part.eq_ignore_ascii_case(local)) {
            parts.push(local.to_owned());
        }
    }
    parts.join(",")
}

fn bypasses_zen(entry: &str) -> bool {
    let entry = entry.trim_start_matches(['.', '*']).to_ascii_lowercase();
    let host = entry
        .rsplit_once(':')
        .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
        .map(|(host, _)| host)
        .unwrap_or(entry.as_str());
    host == "opencode.ai" || host.ends_with(".opencode.ai")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn read<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(PoisonError::into_inner)
}

fn write<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(PoisonError::into_inner)
}

fn lock<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_forms_the_sources_publish() {
        let proxy = parse_proxy("1.2.3.4:1080").unwrap();
        assert_eq!(proxy.scheme, Scheme::Socks5);
        assert_eq!(proxy.url(), "socks5://1.2.3.4:1080");

        let proxy = parse_proxy("socks4://1.2.3.4:1080").unwrap();
        assert_eq!(proxy.scheme, Scheme::Socks4);

        let proxy = parse_proxy("socks5://user:p%40ss@1.2.3.4:1080").unwrap();
        assert_eq!(proxy.username.as_deref(), Some("user"));
        assert_eq!(proxy.password.as_deref(), Some("p@ss"));
        assert_eq!(proxy.url(), "socks5://user:p%40ss@1.2.3.4:1080");

        let proxy = parse_proxy("1.2.3.4:1080:user:pa:ss").unwrap();
        assert_eq!(proxy.password.as_deref(), Some("pa:ss"));

        let proxy = parse_proxy("[::1]:1080").unwrap();
        assert_eq!((proxy.host.as_str(), proxy.port), ("::1", 1080));

        assert!(parse_proxy("1.2.3.4").is_err());
        assert!(parse_proxy("1.2.3.4:0").is_err());
        assert!(parse_proxy("1.2.3.4:99999").is_err());
        assert!(parse_proxy(":1080").is_err());
    }

    #[test]
    fn ipv6_custom_proxies_survive_being_saved() {
        let proxy = parse_proxy("socks5://[2001:db8::1]:1080").unwrap();
        assert_eq!(proxy.url(), "socks5://[2001:db8::1]:1080");
        assert_eq!(parse_proxy(&proxy.url()).unwrap().host, "2001:db8::1");

        let proxy = parse_proxy("socks5://user:pass@[::1]:1080").unwrap();
        assert_eq!((proxy.host.as_str(), proxy.port), ("::1", 1080));
        assert_eq!(proxy.password.as_deref(), Some("pass"));
        assert_eq!(parse_proxy(&proxy.url()).unwrap().host, "::1");
        assert_eq!(proxy.masked(), "[::1]:1080:user:***");
    }

    #[test]
    fn colon_form_passwords_are_taken_verbatim() {
        let proxy = parse_proxy("1.2.3.4:1080:user:pa/ss%41").unwrap();
        assert_eq!(proxy.password.as_deref(), Some("pa/ss%41"));
        let proxy = parse_proxy("1.2.3.4:1080:user:p@ss").unwrap();
        assert_eq!(proxy.host, "1.2.3.4");
        assert_eq!(proxy.password.as_deref(), Some("p@ss"));
        assert_eq!(parse_proxy(&proxy.url()).unwrap().password.as_deref(), Some("p@ss"));
        assert_eq!(
            parse_proxy("socks5://user:p%aé@1.2.3.4:1080").unwrap().password.as_deref(),
            Some("p%aé")
        );
    }

    #[test]
    fn https_proxies_are_refused() {
        assert!(parse_proxy("https://1.2.3.4:8443").is_err());
        assert_eq!(
            parse_proxy("http://1.2.3.4:8080/").unwrap().scheme,
            Scheme::Http
        );
    }

    #[test]
    fn candidates_are_plain_ipv4_hosts() {
        assert_eq!(
            probe_candidate("1.2.3.4:1080", Scheme::Socks4).as_deref(),
            Some("socks4://1.2.3.4:1080")
        );
        assert_eq!(
            probe_candidate("socks5://1.2.3.4:1080", Scheme::Socks4).as_deref(),
            Some("socks5://1.2.3.4:1080")
        );
        assert_eq!(probe_candidate("proxy.example:1080", Scheme::Socks5), None);
        assert_eq!(
            probe_candidate("1.2.3.4:1080:user:pass", Scheme::Socks5),
            None
        );
    }

    #[test]
    fn no_proxy_keeps_zen_inside_the_local_proxy() {
        assert_eq!(
            no_proxy_from("localhost, .opencode.ai, example.com, *.opencode.ai, *"),
            "localhost,example.com,127.0.0.1,::1"
        );
        assert_eq!(no_proxy_from(""), "localhost,127.0.0.1,::1");
    }

    #[test]
    fn masks_credentials_in_display_urls() {
        let proxy = parse_proxy("socks5://user:secret@1.2.3.4:1080").unwrap();
        assert_eq!(proxy.masked(), "1.2.3.4:1080:user:***");
        assert_eq!(mask_url(&proxy.url()), "1.2.3.4:1080:user:***");
    }
}

#[cfg(test)]
mod selection_tests {
    use super::*;

    fn entry(url: &str) -> Entry {
        Entry {
            url: url.into(),
            latency_ms: 10,
            country: None,
            country_code: None,
            proxy: parse_proxy(url).unwrap(),
        }
    }

    fn inner() -> Arc<Inner> {
        Arc::new(Inner {
            settings: RwLock::new(ProxySettings {
                enabled: true,
                custom: None,
                max_latency_ms: 2_000,
            }),
            pool: RwLock::new(PoolState {
                entries: vec![
                    entry("socks5://1.1.1.1:1080"),
                    entry("socks5://2.2.2.2:1080"),
                ],
                ..Default::default()
            }),
            scan: Mutex::new(ScanState::default()),
            tokens: Mutex::new(Tokens::default()),
            refreshing: AtomicBool::new(false),
            client: reqwest::Client::new(),
            fallback: None,
            control: "test".into(),
            listener: tokio::sync::Mutex::new(None),
            closing: tokio::sync::broadcast::channel(64).0,
        })
    }

    #[test]
    fn tokens_stick_and_each_session_gets_its_own_exit() {
        let inner = inner();
        let first = inner.select(Some("one")).unwrap().entry.unwrap();
        assert_eq!(first, "socks5://1.1.1.1:1080");
        let repeated = inner.select(Some("one")).unwrap().entry.unwrap();
        assert_eq!(repeated, first);

        let untokened = inner.select(None).unwrap().entry.unwrap();
        assert_eq!(untokened, "socks5://2.2.2.2:1080");

        let next = inner.select(Some("two")).unwrap().entry.unwrap();
        assert_eq!(next, "socks5://2.2.2.2:1080");
        assert_ne!(next, first);
    }

    #[test]
    fn an_evicted_lease_moves_to_a_free_exit() {
        let inner = inner();
        let first = inner.select(Some("one")).unwrap().entry.unwrap();
        assert_eq!(first, "socks5://1.1.1.1:1080");
        inner.report_token("one", "quota");
        let next = inner.select(Some("one")).unwrap().entry.unwrap();
        assert_eq!(next, "socks5://2.2.2.2:1080");
    }

    #[test]
    fn a_report_closes_the_sessions_tunnels_and_the_evicted_exit() {
        let inner = inner();
        let mut closing = inner.closing.subscribe();
        let first = inner.select(Some("one")).unwrap().entry.unwrap();
        inner.report_token("one", "HTTP 429");
        assert!(matches!(closing.try_recv(), Ok(Closing::Token(token)) if token == "one"));
        assert!(matches!(closing.try_recv(), Ok(Closing::Exit(url)) if url == first));
    }

    #[test]
    fn an_expired_lease_frees_its_exit() {
        let inner = inner();
        lock(&inner.tokens).map.insert(
            "old".into(),
            (
                "socks5://1.1.1.1:1080".into(),
                Instant::now() - TOKEN_TTL - Duration::from_secs(1),
            ),
        );
        let picked = inner.select(Some("new")).unwrap().entry.unwrap();
        assert_eq!(picked, "socks5://1.1.1.1:1080");
    }

    #[test]
    fn alternatives_prefer_exits_no_other_agent_holds() {
        let inner = inner();
        write(&inner.pool).entries.extend([
            entry("socks5://3.3.3.3:1080"),
            entry("socks5://4.4.4.4:1080"),
        ]);
        let one = inner.select(Some("one")).unwrap().entry.unwrap();
        let two = inner.select(Some("two")).unwrap().entry.unwrap();
        assert_ne!(one, two);
        let choices = inner.alternatives(&one, Some("one"), 1);
        assert_eq!(choices.len(), 1);
        assert_eq!(choices[0].url, "socks5://3.3.3.3:1080");
    }

    #[test]
    fn custom_and_disabled_modes_bypass_the_pool() {
        let inner = inner();
        write(&inner.settings).custom = Some("socks5://9.9.9.9:1080".into());
        let selected = inner.select(Some("one")).unwrap();
        assert!(selected.entry.is_none());
        assert!(matches!(selected.upstream, Upstream::Proxy(_)));

        write(&inner.settings).enabled = false;
        let selected = inner.select(Some("one")).unwrap();
        assert!(selected.entry.is_none());
        assert!(matches!(selected.upstream, Upstream::Direct));
    }
}

