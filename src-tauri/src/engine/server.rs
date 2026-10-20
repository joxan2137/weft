use std::ffi::OsString;
use std::io;
use std::net::TcpListener;
use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::time::Duration;

use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
#[cfg(windows)]
use process_wrap::tokio::{CreationFlags, JobObject};
use reqwest::Client;
use serde::Deserialize;
use tauri::async_runtime::{self, JoinHandle};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::oneshot;
use uuid::Uuid;

use super::logs::LogRing;
use super::state::{ErrorKind, Failure};

pub const USERNAME: &str = "weft";
const LISTENING_MARKER: &str = "server listening";
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_INTERVAL: Duration = Duration::from_millis(150);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const EXIT_TAIL: usize = 20;
const SCRUBBED_ENV: [&str; 4] = ["OPENCODE_DB", "OPENCODE_AUTH_CONTENT", "OPENCODE_PURE", "DEBUG"];

pub struct Launch<'a> {
    pub exe: &'a Path,
    pub cwd: &'a Path,
    pub env: &'a [(&'static str, OsString)],
}

pub struct Server {
    child: Box<dyn ChildWrapper>,
    readers: Vec<JoinHandle<()>>,
    pub url: String,
    pub password: String,
    pub version: String,
}

pub enum StartError {
    /// The process died before it was healthy, typically a lost port race (`ServeError`).
    Exited(String),
    Fatal(Failure),
}

impl Server {
    /// Resolves when the engine exits, with a message ending in its last output lines.
    pub async fn exited(mut self, logs: &LogRing) -> String {
        let status = self.child.wait().await;
        drain(std::mem::take(&mut self.readers)).await;
        describe_exit(status, logs)
    }
}

pub async fn start(launch: &Launch<'_>, logs: &Arc<LogRing>) -> Result<Server, StartError> {
    let fatal = |doing: &str, error: io::Error| {
        StartError::Fatal(Failure::new(ErrorKind::Start, format!("{doing}: {error}")))
    };
    let port = free_port().map_err(|error| fatal("picking a free port", error))?;
    let password = Uuid::new_v4().to_string();
    let mut child = spawn(launch, port, &password)
        .map_err(|error| fatal(&format!("starting {}", launch.exe.display()), error))?;

    let (listening_tx, listening_rx) = oneshot::channel();
    let readers = vec![
        read_lines(child.stdout().take(), logs.clone(), Some(listening_tx)),
        read_lines(child.stderr().take(), logs.clone(), None),
    ];
    let url = format!("http://127.0.0.1:{port}");
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| fatal("creating the HTTP client", io::Error::other(error)))?;

    let outcome = tokio::select! {
        status = child.wait() => Err(status),
        ready = tokio::time::timeout(READY_TIMEOUT, wait_ready(&client, &url, &password, listening_rx)) => Ok(ready),
    };
    match outcome {
        Ok(Ok(version)) => Ok(Server {
            child,
            readers,
            url,
            password,
            version,
        }),
        Ok(Err(_)) => Err(StartError::Fatal(Failure::new(
            ErrorKind::Timeout,
            format!(
                "opencode did not report healthy within {} s",
                READY_TIMEOUT.as_secs()
            ),
        ))),
        Err(status) => {
            drain(readers).await;
            Err(StartError::Exited(describe_exit(status, logs)))
        }
    }
}

fn free_port() -> io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

fn spawn(launch: &Launch<'_>, port: u16, password: &str) -> io::Result<Box<dyn ChildWrapper>> {
    let port = port.to_string();
    let mut command = CommandWrap::with_new(launch.exe, |command| {
        command
            .args(["serve", "--hostname", "127.0.0.1", "--port", &port])
            .current_dir(launch.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for key in SCRUBBED_ENV {
            command.env_remove(key);
        }
        command
            .envs(launch.env.iter().map(|(key, value)| (*key, value)))
            .env("OPENCODE_SERVER_USERNAME", USERNAME)
            .env("OPENCODE_SERVER_PASSWORD", password);
    });
    #[cfg(windows)]
    command
        .wrap(JobObject)
        .wrap(CreationFlags(windows::Win32::System::Threading::CREATE_NO_WINDOW));
    command.wrap(KillOnDrop);
    command.spawn()
}

fn read_lines(
    stream: Option<impl AsyncRead + Unpin + Send + 'static>,
    logs: Arc<LogRing>,
    mut listening: Option<oneshot::Sender<()>>,
) -> JoinHandle<()> {
    async_runtime::spawn(async move {
        let Some(stream) = stream else { return };
        let mut lines = BufReader::new(stream).split(b'\n');
        while let Ok(Some(bytes)) = lines.next_segment().await {
            let line = String::from_utf8_lossy(&bytes).trim_end_matches('\r').to_owned();
            if line.contains(LISTENING_MARKER)
                && let Some(listening) = listening.take()
            {
                let _ = listening.send(());
            }
            logs.push(line);
        }
    })
}

async fn wait_ready(
    client: &Client,
    url: &str,
    password: &str,
    listening: oneshot::Receiver<()>,
) -> String {
    if listening.await.is_err() {
        std::future::pending::<()>().await;
    }
    loop {
        if let Some(version) = health(client, url, password).await {
            return version;
        }
        tokio::time::sleep(HEALTH_INTERVAL).await;
    }
}

async fn health(client: &Client, url: &str, password: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Health {
        healthy: bool,
        version: String,
    }

    let health: Health = client
        .get(format!("{url}/global/health"))
        .basic_auth(USERNAME, Some(password))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    health.healthy.then_some(health.version)
}

async fn drain(readers: Vec<JoinHandle<()>>) {
    for reader in readers {
        let _ = tokio::time::timeout(DRAIN_TIMEOUT, reader).await;
    }
}

fn describe_exit(status: io::Result<ExitStatus>, logs: &LogRing) -> String {
    let status = match status {
        Ok(status) => status.to_string(),
        Err(error) => error.to_string(),
    };
    let mut message = format!("opencode exited ({status})");
    for line in logs.tail(EXIT_TAIL) {
        message.push('\n');
        message.push_str(&line);
    }
    message
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::super::plugin;
    use super::*;

    /// Stands in for the user's existing `~/.config/opencode`, whose lockfile already names
    /// `@opencode-ai/plugin`, so the engine has no reason to run npm.
    fn seed_global_config(dir: &Path) {
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        let deps = r#"{"dependencies":{"@opencode-ai/plugin":"1.19.1"}}"#;
        fs::write(dir.join("package.json"), deps).unwrap();
        let lock = format!(r#"{{"lockfileVersion":3,"requires":true,"packages":{{"":{deps}}}}}"#);
        fs::write(dir.join("package-lock.json"), lock).unwrap();
    }

    /// Spawns a real engine with the Weft plugin in a throwaway sandbox:
    /// `WEFT_TEST_ENGINE=<opencode.exe> cargo test -- --ignored`.
    #[test]
    #[ignore = "needs WEFT_TEST_ENGINE"]
    fn starts_isolated_engine_with_plugin_and_kills_it_on_drop() {
        let exe = std::path::PathBuf::from(std::env::var_os("WEFT_TEST_ENGINE").unwrap());
        let root = std::env::temp_dir().join(format!("weft-spawn-{}", Uuid::new_v4().simple()));
        let global_config = root.join("config").join("opencode");
        seed_global_config(&global_config);
        let plugins = root.join("plugins");
        let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("plugin");
        plugin::copy_bundled(&bundled, &plugins).unwrap();

        let mut env: Vec<(&'static str, OsString)> = [
            ("XDG_DATA_HOME", "data"),
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_CACHE_HOME", "cache"),
            ("XDG_STATE_HOME", "state"),
            ("WEFT_OBSERVED_DIR", "observed"),
            ("WEFT_WORKFLOWS_DIR", "workflows"),
        ]
        .into_iter()
        .map(|(key, dir)| (key, root.join(dir).into_os_string()))
        .collect();
        env.push(("OPENCODE_CONFIG_CONTENT", plugin::config_content(&plugins).unwrap().into()));
        let logs = Arc::new(LogRing::default());

        async_runtime::block_on(async {
            let launch = Launch {
                exe: &exe,
                cwd: &root,
                env: &env,
            };
            let Ok(server) = start(&launch, &logs).await else {
                panic!("engine did not start: {:?}", logs.snapshot());
            };
            let client = Client::builder().no_proxy().build().unwrap();
            let (url, password) = (server.url.clone(), server.password.clone());
            assert_eq!(health(&client, &url, &password).await, Some(server.version.clone()));
            assert!(logs.snapshot().iter().any(|line| line.contains(LISTENING_MARKER)));

            let tool_ids = client
                .get(format!("{url}/experimental/tool/ids"))
                .basic_auth(USERNAME, Some(&password))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            assert!(tool_ids.contains(&format!("\"{}\"", plugin::CANARY)), "{tool_ids}");

            tokio::time::sleep(Duration::from_secs(3)).await;
            let installed = fs::read_dir(global_config.join("node_modules")).unwrap().count();
            assert_eq!(installed, 0, "the engine ran npm in the global config dir");
            assert!(!plugins.join("node_modules").exists());

            drop(server);
            tokio::time::sleep(Duration::from_secs(1)).await;
            assert_eq!(health(&client, &url, &password).await, None);
        });
        let _ = fs::remove_dir_all(root);
    }
}
