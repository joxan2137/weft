mod activity;
mod desktop;
mod follow;
mod install;
mod lithos;
mod logs;
mod migrations;
mod npm;
mod opengateway;
mod plugin;
mod probe;
mod server;
mod state;
mod version;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::Client;
use tauri::async_runtime::{self, JoinHandle};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

pub use desktop::{LegacyDesktop, installed_version as desktop_version, legacy as legacy_desktop};
pub use state::EngineState;

use crate::applog;
use crate::paths::AppPaths;
use crate::proxy::Proxy;
use crate::settings::{self, EngineSettings};
use activity::Instances;
use follow::{Backoff, Decision};
use logs::LogRing;
use server::{Launch, Server, StartError};
use state::{ErrorKind, Failure, OrFail};

pub const STATE_EVENT: &str = "engine://state";
const BUNDLED_PLUGINS: &str = "opencode/plugins";
const DESKTOP_POLL: Duration = Duration::from_secs(60);
const IDLE_POLL: Duration = Duration::from_secs(5);
const IDLE_WAIT: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub struct Engine {
    state: Mutex<EngineState>,
    logs: Arc<LogRing>,
    instances: Instances,
    current: tokio::sync::Mutex<Current>,
}

#[derive(Default)]
struct Current {
    task: Option<JoinHandle<()>>,
    /// The OpenCode Desktop version this launch follows.
    desktop: Option<String>,
    /// The Desktop version being prepared while the running engine keeps serving.
    switch: Option<(String, JoinHandle<()>)>,
}

impl Current {
    async fn relaunch(&mut self, app: AppHandle, desktop: Option<String>) {
        self.cancel_switch().await;
        abort(self.task.take()).await;
        self.desktop.clone_from(&desktop);
        self.task = Some(async_runtime::spawn(run(app, desktop)));
    }

    async fn cancel_switch(&mut self) {
        abort(self.switch.take().map(|(_, task)| task)).await;
    }
}

impl Engine {
    pub fn state(&self) -> EngineState {
        self.state.lock().unwrap().clone()
    }

    pub fn logs(&self) -> Vec<String> {
        self.logs.snapshot()
    }

    /// Starts the engine, then keeps it on the installed OpenCode Desktop's version.
    pub async fn boot(&self, app: AppHandle) {
        adopt_legacy_engines(&app).await;
        self.restart(app.clone()).await;
        loop {
            tokio::time::sleep(DESKTOP_POLL).await;
            self.follow_desktop(app.clone()).await;
        }
    }

    /// Kills the running engine (if any) and starts the resolve → install → start sequence anew.
    pub async fn restart(&self, app: AppHandle) {
        let desktop = desktop::installed_version();
        self.current.lock().await.relaunch(app, desktop).await;
    }

    /// An updated Desktop migrates the shared DB when it next starts, so our engine moves to the
    /// new version: installed and checked in the background, swapped in once no session is busy.
    pub async fn follow_desktop(&self, app: AppHandle) {
        let mut current = self.current.lock().await;
        if current.task.is_none() {
            return;
        }
        let installed = desktop::installed_version();
        match follow::decide(&self.state(), current.desktop.as_deref(), installed.as_deref()) {
            Decision::Keep => {}
            Decision::Settled => current.cancel_switch().await,
            Decision::Relaunch => current.relaunch(app, installed).await,
            Decision::Switch(version) => {
                if current.switch.as_ref().is_none_or(|(pending, _)| *pending != version) {
                    current.cancel_switch().await;
                    let task = async_runtime::spawn(switch(app, version.clone()));
                    current.switch = Some((version, task));
                }
            }
        }
    }

    pub async fn stop(&self) {
        let mut current = self.current.lock().await;
        current.cancel_switch().await;
        abort(current.task.take()).await;
    }
}

/// Engines of earlier builds sit in the install folder, where uninstalling leaves them behind.
async fn adopt_legacy_engines(app: &AppHandle) {
    let Ok(paths) = AppPaths::resolve(app) else {
        return;
    };
    if !paths.legacy_engines.exists() {
        return;
    }
    let (legacy, engines) = (paths.legacy_engines, paths.engines);
    let summary = format!("moving engines from {} to {}", legacy.display(), engines.display());
    let moved = async_runtime::spawn_blocking(move || install::adopt_legacy(&legacy, &engines))
        .await
        .map_err(|error| error.to_string())
        .and_then(|moved| moved.map_err(|error| error.to_string()));
    match moved {
        Ok(()) => applog::line("weft", summary),
        Err(error) => applog::line("weft", format!("{summary} failed: {error}")),
    }
}

/// Dropping the task drops the engine's job object, which kills the whole process tree.
async fn abort(task: Option<JoinHandle<()>>) {
    if let Some(task) = task {
        task.abort();
        let _ = task.await;
    }
}

fn publish(app: &AppHandle, state: EngineState) {
    if let Some(summary) = state.summary() {
        applog::line("weft", summary);
    }
    *app.state::<Engine>().state.lock().unwrap() = state.clone();
    let _ = app.emit(STATE_EVENT, state);
}

/// Replaces the notice of a ready engine; any other state has none to show.
fn notify(app: &AppHandle, notice: Option<String>) {
    let changed = {
        let engine = app.state::<Engine>();
        let mut state = engine.state.lock().unwrap();
        match &mut *state {
            EngineState::Ready { notice: shown, .. } if *shown != notice => {
                *shown = notice;
                Some(state.clone())
            }
            _ => None,
        }
    };
    if let Some(state) = changed {
        let _ = app.emit(STATE_EVENT, state);
    }
}

async fn run(app: AppHandle, desktop: Option<String>) {
    let engine = app.state::<Engine>();
    let logs = engine.logs.clone();
    engine.instances.clear();
    match launch(&app, &logs, desktop.as_deref()).await {
        Ok((server, notice)) => {
            if let Some(notice) = &notice {
                logs.push(format!("weft: {notice}"));
            }
            let url = server.url.clone();
            let password = server.password.clone();
            publish(
                &app,
                EngineState::Ready {
                    url: url.clone(),
                    username: server::USERNAME.to_owned(),
                    password: password.clone(),
                    version: server.version.clone(),
                    notice,
                },
            );
            let message = tokio::select! {
                message = server.exited(&logs) => message,
                never = engine.instances.watch(&url, &password) => match never {},
            };
            publish(&app, Failure::new(ErrorKind::Exited, message).into());
        }
        Err(failure) => publish(&app, failure.into()),
    }
}

/// Installs and checks the engine for an updated Desktop while the running one keeps serving,
/// then restarts onto it once no session is busy.
async fn switch(app: AppHandle, desktop: String) {
    let engine = app.state::<Engine>();
    let mut backoff = Backoff::default();
    while let Err(failure) = prepare(&app, &desktop).await {
        let delay = backoff.next();
        engine.logs.push(format!(
            "weft: not switching to opencode {desktop} yet, retrying in {} s: {}",
            delay.as_secs(),
            failure.message
        ));
        let waiting = if failure.kind == ErrorKind::EngineNewerThanDb {
            "after it has upgraded the database (open OpenCode Desktop once)".to_owned()
        } else {
            format!(
                "once opencode {desktop} is ready, retrying in {} s: {}",
                delay.as_secs(),
                failure.message
            )
        };
        notify(
            &app,
            Some(format!("restarting for OpenCode Desktop {desktop} {waiting}")),
        );
        tokio::time::sleep(delay).await;
    }

    notify(
        &app,
        Some(format!("restarting for OpenCode Desktop {desktop} once no session is busy")),
    );
    let deadline = Instant::now() + IDLE_WAIT;
    while Instant::now() < deadline {
        let EngineState::Ready { url, password, .. } = engine.state() else {
            break;
        };
        if !engine.instances.busy(&url, &password).await {
            break;
        }
        tokio::time::sleep(IDLE_POLL).await;
    }

    let mut current = engine.current.lock().await;
    drop(current.switch.take());
    current.relaunch(app.clone(), Some(desktop)).await;
}

/// Installs `version` and checks it against the shared DB without touching the running engine.
async fn prepare(app: &AppHandle, version: &str) -> Result<(), Failure> {
    let paths = AppPaths::resolve(app).or_fail(ErrorKind::Config, "resolving app directories")?;
    let settings = settings::load(app);
    let client = npm::client()?;
    let exe = install(&client, &paths, version, |_, _| {}).await?;
    check(&paths, &settings, &exe, version).await
}

/// Where the engine comes from, and the version it stands in for when that one was skipped.
struct Located {
    exe: PathBuf,
    version: String,
    wanted: Option<String>,
    skipped: Option<Failure>,
}

async fn launch(
    app: &AppHandle,
    logs: &Arc<LogRing>,
    desktop: Option<&str>,
) -> Result<(Server, Option<String>), Failure> {
    publish(app, EngineState::Resolving);
    let paths = AppPaths::resolve(app).or_fail(ErrorKind::Config, "resolving app directories")?;
    let settings = settings::load(app);
    let client = npm::client()?;
    let Located {
        exe,
        version,
        wanted,
        skipped,
    } = locate(app, &client, &paths, &settings, desktop).await?;

    publish(app, EngineState::Starting { version: version.clone() });
    let bundled_plugins = app
        .path()
        .resolve(BUNDLED_PLUGINS, BaseDirectory::Resource)
        .or_fail(ErrorKind::Config, "locating the bundled plugin")?;
    plugin::copy_bundled(&bundled_plugins, &paths.plugins)
        .or_fail(ErrorKind::Config, "installing the Weft plugin")?;
    let config_content = plugin::config_content(&paths.plugins).ok_or_else(|| {
        Failure::new(
            ErrorKind::Config,
            format!("{} is not an absolute path", paths.plugins.display()),
        )
    })?;
    std::fs::create_dir_all(&paths.observed)
        .or_fail(ErrorKind::Config, "creating the observed dir")?;

    let proxy_env = app.state::<Proxy>().engine_env(app).await;
    let env = engine_env(&paths, config_content, desktop.is_some(), proxy_env);
    let launch = Launch {
        exe: &exe,
        cwd: &paths.home,
        env: &env,
    };
    let server = match server::start(&launch, logs).await {
        Err(StartError::Exited(_)) => server::start(&launch, logs).await,
        first => first,
    }
    .map_err(|error| match error {
        StartError::Exited(message) => Failure::new(ErrorKind::Start, message),
        StartError::Fatal(failure) => failure,
    })?;

    if server.version != version {
        return Err(Failure::new(
            ErrorKind::VersionMismatch,
            format!(
                "expected opencode {version}, the engine reports {}",
                server.version
            ),
        ));
    }

    let keep: Vec<String> = [Some(version.clone()), wanted.clone(), desktop::installed_version()]
        .into_iter()
        .flatten()
        .collect();
    let engines = paths.engines.clone();
    async_runtime::spawn_blocking(move || install::prune(&engines, &keep));

    let notice = wanted.zip(skipped).map(|(wanted, failure)| {
        format!(
            "running opencode {version} because opencode {wanted} was skipped: {}",
            failure.message
        )
    });
    Ok((server, notice))
}

/// OpenCode Desktop pins the version (it shares `opencode.db`), then a custom `engine.path`,
/// then the latest npm release. When that version cannot be installed or does not match the DB,
/// the newest installed engine that does match runs instead.
async fn locate(
    app: &AppHandle,
    client: &Client,
    paths: &AppPaths,
    settings: &EngineSettings,
    desktop: Option<&str>,
) -> Result<Located, Failure> {
    if desktop.is_none()
        && let Some(exe) = settings.engine_path()
    {
        let version = probe::version(&exe).await?;
        check(paths, settings, &exe, &version).await?;
        return Ok(Located {
            exe,
            version,
            wanted: None,
            skipped: None,
        });
    }
    let wanted = match desktop {
        Some(version) => version.to_owned(),
        None => match npm::latest(client).await {
            Ok(version) => version,
            Err(failure) => return fallback(paths, settings, None, failure).await,
        },
    };
    let progress = |received, total| {
        publish(
            app,
            EngineState::Installing {
                version: wanted.clone(),
                received,
                total,
            },
        );
    };
    let ready = match install(client, paths, &wanted, progress).await {
        Ok(exe) => check(paths, settings, &exe, &wanted).await.map(|()| exe),
        Err(failure) => Err(failure),
    };
    match ready {
        Ok(exe) => Ok(Located {
            exe,
            version: wanted.clone(),
            wanted: Some(wanted),
            skipped: None,
        }),
        Err(failure) => fallback(paths, settings, Some(wanted), failure).await,
    }
}

async fn fallback(
    paths: &AppPaths,
    settings: &EngineSettings,
    wanted: Option<String>,
    failure: Failure,
) -> Result<Located, Failure> {
    for version in install::installed(&paths.engines) {
        if wanted.as_deref() == Some(version.as_str()) {
            continue;
        }
        let exe = paths.engines.join(&version).join(install::EXE);
        if check(paths, settings, &exe, &version).await.is_ok() {
            return Ok(Located {
                exe,
                version,
                wanted,
                skipped: Some(failure),
            });
        }
    }
    Err(failure)
}

async fn install(
    client: &Client,
    paths: &AppPaths,
    version: &str,
    progress: impl FnMut(u64, Option<u64>),
) -> Result<PathBuf, Failure> {
    if !version::is_valid(version) {
        return Err(Failure::new(
            ErrorKind::Resolve,
            format!("invalid engine version {version:?}"),
        ));
    }
    install::ensure(client, &paths.engines.join(version), version, progress).await
}

async fn check(
    paths: &AppPaths,
    settings: &EngineSettings,
    exe: &Path,
    version: &str,
) -> Result<(), Failure> {
    migrations::guard(
        exe,
        version,
        &paths.engines.join(version).join("migrations.json"),
        &migrations::shared_db(&paths.home),
        settings.allow_migrate,
    )
    .await
}

fn engine_env(
    paths: &AppPaths,
    config_content: String,
    share_desktop_state: bool,
    extra: Vec<(&'static str, OsString)>,
) -> Vec<(&'static str, OsString)> {
    let mut env = vec![
        ("OPENCODE_CONFIG_CONTENT", config_content.into()),
        ("OPENCODE_DISABLE_AUTOUPDATE", "1".into()),
        ("OPENCODE_CLIENT", "weft".into()),
        ("OPENCODE_ENABLE_QUESTION_TOOL", "1".into()),
        ("OPENCODE_EXPERIMENTAL_FILEWATCHER", "true".into()),
        ("WEFT_OBSERVED_DIR", paths.observed.clone().into()),
        ("WEFT_WORKFLOWS_DIR", paths.workflows.clone().into()),
    ];
    if share_desktop_state && std::env::var_os("XDG_STATE_HOME").is_none() {
        // Desktop's state root holds opencode's cross-process locks; sharing it serialises
        // config installs between the two engines. Like Desktop, an inherited value wins.
        env.push(("XDG_STATE_HOME", paths.desktop_state.clone().into()));
    }
    env.extend(extra);
    env
}
