use std::path::PathBuf;

use tauri::{AppHandle, Manager};

pub struct AppPaths {
    pub data: PathBuf,
    pub logs: PathBuf,
    pub plugins: PathBuf,
    pub observed: PathBuf,
    /// Workflow runs: each run's script and the journal a later call resumes from.
    pub workflows: PathBuf,
    pub engines: PathBuf,
    /// Where earlier builds kept engines: inside the per-user install folder, which the
    /// uninstaller never empties.
    pub legacy_engines: PathBuf,
    pub home: PathBuf,
    pub local_data: PathBuf,
    pub desktop_state: PathBuf,
}

impl AppPaths {
    pub fn resolve(app: &AppHandle) -> tauri::Result<Self> {
        let path = app.path();
        let config = path.app_config_dir()?;
        let local_data = path.local_data_dir()?;
        let app_local_data = path.app_local_data_dir()?;
        Ok(Self {
            plugins: config.join("plugins"),
            observed: config.join("observed"),
            data: path.app_data_dir()?,
            logs: path.app_log_dir()?,
            workflows: app_local_data.join("workflows"),
            engines: app_local_data.join("engines"),
            legacy_engines: local_data.join("Weft").join("engines"),
            home: path.home_dir()?,
            desktop_state: path.data_dir()?.join("ai.opencode.desktop"),
            local_data,
        })
    }
}

/// The folder `app_log_dir()` resolves to on Windows, known before the app (and its path
/// resolver) exists, so a failed start still leaves a log behind.
pub fn early_log_dir(identifier: &str) -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|local| PathBuf::from(local).join(identifier).join("logs"))
}
