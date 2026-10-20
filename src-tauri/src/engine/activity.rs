use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;

use super::server::USERNAME;

const RECONNECT: Duration = Duration::from_secs(2);
const STATUS_TIMEOUT: Duration = Duration::from_secs(5);
const DISPOSED: &str = "server.instance.disposed";

/// Directories the engine has an instance loaded for. Session status lives per instance, so
/// these are the places to ask whether a session is busy.
#[derive(Default)]
pub struct Instances(Mutex<HashSet<String>>);

#[derive(Deserialize)]
struct GlobalEvent {
    directory: Option<String>,
    payload: Payload,
}

#[derive(Deserialize)]
struct Payload {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct Status {
    #[serde(rename = "type")]
    kind: String,
}

impl Instances {
    pub fn clear(&self) {
        self.0.lock().unwrap().clear();
    }

    /// Follows `/global/event` for as long as the engine runs.
    pub async fn watch(&self, url: &str, password: &str) -> Infallible {
        let Ok(client) = Client::builder().no_proxy().build() else {
            return std::future::pending().await;
        };
        loop {
            let _ = self.follow(&client, url, password).await;
            tokio::time::sleep(RECONNECT).await;
        }
    }

    /// True while any loaded instance has a session that is not idle, or cannot be asked.
    pub async fn busy(&self, url: &str, password: &str) -> bool {
        let Ok(client) = Client::builder().no_proxy().timeout(STATUS_TIMEOUT).build() else {
            return false;
        };
        let directories: Vec<String> = self.0.lock().unwrap().iter().cloned().collect();
        for directory in directories {
            let statuses = client
                .get(format!("{url}/session/status"))
                .query(&[("directory", &directory)])
                .basic_auth(USERNAME, Some(password))
                .send()
                .await
                .and_then(reqwest::Response::error_for_status);
            let busy = match statuses {
                Ok(response) => response
                    .json::<HashMap<String, Status>>()
                    .await
                    .map_or(true, |statuses| statuses.values().any(|status| status.kind != "idle")),
                Err(_) => true,
            };
            if busy {
                return true;
            }
        }
        false
    }

    async fn follow(&self, client: &Client, url: &str, password: &str) -> reqwest::Result<()> {
        let mut response = client
            .get(format!("{url}/global/event"))
            .basic_auth(USERNAME, Some(password))
            .send()
            .await?
            .error_for_status()?;
        let mut pending = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            pending.extend_from_slice(&chunk);
            while let Some(end) = pending.iter().position(|&byte| byte == b'\n') {
                let line: Vec<u8> = pending.drain(..=end).collect();
                if let Some(data) = line.strip_prefix(b"data:") {
                    self.observe(data.trim_ascii());
                }
            }
        }
        Ok(())
    }

    fn observe(&self, data: &[u8]) {
        let Ok(event) = serde_json::from_slice::<GlobalEvent>(data) else {
            return;
        };
        let Some(directory) = event.directory.filter(|dir| Path::new(dir).is_absolute()) else {
            return;
        };
        let mut directories = self.0.lock().unwrap();
        if event.payload.kind == DISPOSED {
            directories.remove(&directory);
        } else {
            directories.insert(directory);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loaded(instances: &Instances) -> Vec<String> {
        let mut directories: Vec<String> = instances.0.lock().unwrap().iter().cloned().collect();
        directories.sort();
        directories
    }

    #[test]
    fn tracks_instances_from_global_events() {
        let instances = Instances::default();
        let event = |directory: &str, kind: &str| {
            serde_json::json!({ "directory": directory, "payload": { "type": kind, "properties": {} } })
                .to_string()
        };
        instances.observe(event(r"C:\work\a", "session.status").as_bytes());
        instances.observe(event(r"C:\work\b", "plugin.added").as_bytes());
        instances.observe(event("global", "server.connected").as_bytes());
        instances.observe(br#"{"payload":{"type":"server.connected"}}"#);
        instances.observe(b"not json");
        assert_eq!(loaded(&instances), [r"C:\work\a", r"C:\work\b"]);

        instances.observe(event(r"C:\work\a", DISPOSED).as_bytes());
        assert_eq!(loaded(&instances), [r"C:\work\b"]);
    }
}
