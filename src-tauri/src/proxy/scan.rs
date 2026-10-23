use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::task::JoinSet;

use super::*;

#[derive(Clone)]
enum Outcome {
    Ok(Entry),
    Transport,
    Status,
    Quota,
    Slow,
}

struct RefreshGuard<'a>(&'a AtomicBool);

impl Drop for RefreshGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub(crate) async fn run(inner: Arc<Inner>) {
    let _guard = RefreshGuard(&inner.refreshing);
    let settings = read(&inner.settings).clone();
    if !settings.enabled || settings.custom.is_some() {
        return;
    }

    {
        let mut scan = lock(&inner.scan);
        scan.total = 0;
        scan.tested = 0;
        scan.working = 0;
        scan.last_error = None;
    }
    applog::line("proxy", "scan started");
    let candidates = fetch_candidates(&inner).await;
    let total = candidates.len();
    lock(&inner.scan).total = total;
    if total == 0 {
        let summary = ScanSummary {
            tested: 0,
            working: 0,
            failed: 0,
            transport: 0,
            status: 0,
            quota: 0,
            slow: 0,
        };
        let mut scan = lock(&inner.scan);
        scan.last = Some(summary);
        scan.last_at = Some(now_ms());
        scan.last_error = Some("no proxy candidates fetched".into());
        write(&inner.pool).last_refresh = Some(Instant::now());
        applog::line("proxy", "scan found no candidates");
        return;
    }

    let mut pending = candidates.into_iter();
    let mut running = JoinSet::new();
    let mut next = 0;
    while next < PROBE_CONCURRENCY {
        let Some(candidate) = pending.next() else {
            break;
        };
        spawn_probe(&mut running, &inner, candidate, settings.max_latency_ms);
        next += 1;
    }

    let mut outcomes = Vec::with_capacity(total);
    let mut working = 0;
    while let Some(joined) = running.join_next().await {
        let outcome = joined.unwrap_or(Outcome::Transport);
        if let Outcome::Ok(entry) = &outcome {
            working += 1;
            lock(&inner.scan).working = working;
            if read(&inner.settings).enabled {
                add_live(&inner, entry.clone());
            }
        }
        lock(&inner.scan).tested += 1;
        outcomes.push(outcome);
        let enabled = read(&inner.settings).enabled;
        if enabled
            && working < WORKING_TARGET
            && let Some(candidate) = pending.next()
        {
            spawn_probe(&mut running, &inner, candidate, settings.max_latency_ms);
        }
    }

    let mut transport = 0;
    let mut status = 0;
    let mut quota = 0;
    let mut slow = 0;
    for outcome in &outcomes {
        match outcome {
            Outcome::Ok(_) => {}
            Outcome::Transport => transport += 1,
            Outcome::Status => status += 1,
            Outcome::Quota => quota += 1,
            Outcome::Slow => slow += 1,
        }
    }
    let tested = outcomes.len();
    let summary = ScanSummary {
        tested,
        working,
        failed: tested - working,
        transport,
        status,
        quota,
        slow,
    };

    let enabled = read(&inner.settings).enabled;
    let mut kept: Vec<Entry> = outcomes
        .into_iter()
        .filter_map(|outcome| match outcome {
            Outcome::Ok(entry) => Some(entry),
            _ => None,
        })
        .collect();
    kept.sort_by_key(|entry| entry.latency_ms);
    let mut seen = HashSet::new();
    kept.retain(|entry| seen.insert(entry.url.clone()));
    kept.truncate(POOL_SIZE);

    let mut scan = lock(&inner.scan);
    scan.last = Some(summary.clone());
    scan.last_at = Some(now_ms());
    scan.total = total;
    scan.tested = tested;
    scan.working = working;
    drop(scan);

    let mut pool = write(&inner.pool);
    pool.last_refresh = Some(Instant::now());
    if enabled && !kept.is_empty() {
        applog::line(
            "proxy",
            format!(
                "scan kept {} of {} working proxies, fastest {} ms",
                kept.len(),
                working,
                kept[0].latency_ms
            ),
        );
        pool.entries = kept;
        pool.cursor = 0;
        pool.strikes.clear();
        lock(&inner.scan).last_error = None;
    } else if enabled {
        applog::line(
            "proxy",
            format!("scan found no working proxies ({tested} tested)"),
        );
        lock(&inner.scan).last_error = Some("no working proxies found".into());
    } else {
        applog::line("proxy", "scan finished while the proxy was disabled");
    }
}

fn spawn_probe(
    running: &mut JoinSet<Outcome>,
    inner: &Arc<Inner>,
    candidate: String,
    max_latency_ms: u64,
) {
    running.spawn(probe(inner.clone(), candidate, max_latency_ms));
}

fn add_live(inner: &Inner, entry: Entry) {
    let mut pool = write(&inner.pool);
    if pool.entries.iter().any(|kept| kept.url == entry.url) {
        return;
    }
    pool.entries.push(entry);
    pool.entries.sort_by_key(|entry| entry.latency_ms);
    pool.entries.truncate(POOL_SIZE);
}

async fn probe(inner: Arc<Inner>, candidate: String, max_latency_ms: u64) -> Outcome {
    let Ok(proxy) = parse_proxy(&candidate) else {
        return Outcome::Transport;
    };
    let Ok(health) = client(&proxy, HEALTH_TIMEOUT) else {
        return Outcome::Transport;
    };
    let started = Instant::now();
    let Ok(response) = health.get(HEALTH_URL).send().await else {
        return Outcome::Transport;
    };
    let status = response.status().as_u16();
    drop(response);
    if !matches!(status, 200 | 301 | 302) {
        return Outcome::Status;
    }
    let latency_ms = started.elapsed().as_millis() as u64;
    if latency_ms > max_latency_ms {
        return Outcome::Slow;
    }

    let Ok(zen) = client(&proxy, ZEN_TIMEOUT) else {
        return Outcome::Transport;
    };
    let body = serde_json::json!({
        "model": zen_model(),
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 1,
        "stream": false,
    });
    let Ok(response) = zen
        .post(ZEN_CHAT_URL)
        .header("authorization", "Bearer public")
        .json(&body)
        .send()
        .await
    else {
        return Outcome::Transport;
    };
    match response.status().as_u16() {
        429 => return Outcome::Quota,
        408 | 425 | 500..=599 => return Outcome::Transport,
        _ => {}
    }
    drop(response);

    let geo = lookup_country(&inner, &proxy.host).await;
    if let Some(geo) = &geo
        && read(&inner.pool)
            .blocked
            .contains(&geo.country_code.to_ascii_uppercase())
    {
        return Outcome::Quota;
    }
    Outcome::Ok(Entry {
        url: proxy.url(),
        latency_ms,
        country: geo.as_ref().map(|geo| geo.country.clone()),
        country_code: geo.map(|geo| geo.country_code),
        proxy,
    })
}

fn client(proxy: &ParsedProxy, timeout: Duration) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .proxy(reqwest::Proxy::all(proxy.probe_url())?)
        .build()
}

fn zen_model() -> String {
    std::env::var("WEFT_ZEN_PROBE_MODEL")
        .or_else(|_| std::env::var("OPENCODE_ZEN_PROBE_MODEL"))
        .ok()
        .map(|model| model.trim().to_owned())
        .filter(|model| !model.is_empty())
        .unwrap_or_else(|| ZEN_PROBE_MODEL.to_owned())
}

#[derive(Deserialize)]
struct GeoResponse {
    status: String,
    country: String,
    #[serde(rename = "countryCode")]
    country_code: String,
}

async fn lookup_country(inner: &Inner, host: &str) -> Option<Geo> {
    if let Some(geo) = read(&inner.pool).country_cache.get(host) {
        return Some(geo.clone());
    }
    let url = format!("{GEO_LOOKUP_URL}/{host}?fields=status,country,countryCode");
    let response = tokio::time::timeout(Duration::from_secs(5), inner.client.get(url).send())
        .await
        .ok()?
        .ok()?;
    let body: GeoResponse = tokio::time::timeout(Duration::from_secs(5), response.json())
        .await
        .ok()?
        .ok()?;
    if !body.status.eq_ignore_ascii_case("success") || body.country_code.is_empty() {
        return None;
    }
    let geo = Geo {
        country: body.country,
        country_code: body.country_code,
    };
    write(&inner.pool)
        .country_cache
        .insert(host.to_owned(), geo.clone());
    Some(geo)
}

async fn fetch_candidates(inner: &Arc<Inner>) -> Vec<String> {
    let mut running = JoinSet::new();
    for (index, (url, scheme)) in SOURCES.into_iter().enumerate() {
        let client = inner.client.clone();
        running.spawn(async move { (index, fetch_source(&client, url, scheme).await) });
    }
    let mut lists = vec![Vec::new(); SOURCES.len()];
    while let Some(joined) = running.join_next().await {
        if let Ok((index, list)) = joined {
            lists[index] = list;
        }
    }
    let parsed: usize = lists.iter().map(Vec::len).sum();
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    let mut index = 0;
    loop {
        let mut advanced = false;
        for list in &lists {
            let Some(candidate) = list.get(index) else {
                continue;
            };
            advanced = true;
            if seen.insert(candidate.clone()) {
                merged.push(candidate.clone());
                if merged.len() >= CANDIDATE_LIMIT {
                    applog::line(
                        "proxy",
                        format!("{parsed} candidates parsed, {} sampled", merged.len()),
                    );
                    return merged;
                }
            }
        }
        if !advanced {
            break;
        }
        index += 1;
    }
    applog::line(
        "proxy",
        format!("{parsed} candidates parsed, {} sampled", merged.len()),
    );
    merged
}

async fn fetch_source(client: &reqwest::Client, url: &str, scheme: Scheme) -> Vec<String> {
    let Ok(response) = client.get(url).send().await else {
        return Vec::new();
    };
    if !response.status().is_success() {
        return Vec::new();
    }
    let Ok(bytes) = response.bytes().await else {
        return Vec::new();
    };
    let limit = bytes.len().min(2 * 1024 * 1024);
    let text = String::from_utf8_lossy(&bytes[..limit]);
    let mut candidates: Vec<String> = text
        .lines()
        .filter_map(|line| probe_candidate(line, scheme))
        .collect();
    fastrand::shuffle(&mut candidates);
    candidates
}
