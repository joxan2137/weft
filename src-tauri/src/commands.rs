use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::applog;
use crate::engine::{self, Engine, EngineState, LegacyDesktop};
use crate::observed;
use crate::paths::AppPaths;
use crate::settings::{self, EngineSettings, SettingsPatch};

type CommandResult<T> = Result<T, String>;

/// Extensions Windows runs rather than shows when the saved file is opened (as in Review.tsx).
const RUNNABLE: [&str; 46] = [
    "exe", "com", "bat", "cmd", "msi", "msp", "msc", "scr", "pif", "cpl", "hta", "lnk", "url",
    "reg", "inf", "scf", "sct", "shb", "shs", "jar", "chm", "js", "jse", "vbs", "vbe", "vb", "wsf",
    "wsh", "ws", "ps1", "psm1", "psd1", "ps1xml", "psc1", "application", "appref-ms", "appx",
    "appxbundle", "msix", "msixbundle", "appinstaller", "gadget", "diagcab", "settingcontent-ms",
    "library-ms", "search-ms",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    log_dir: PathBuf,
    data_dir: PathBuf,
    engines_dir: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    desktop_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    legacy_desktop: Option<LegacyDesktop>,
}

#[tauri::command]
pub async fn engine_status(engine: State<'_, Engine>) -> CommandResult<EngineState> {
    Ok(engine.state())
}

#[tauri::command]
pub async fn engine_restart(app: AppHandle, engine: State<'_, Engine>) -> CommandResult<()> {
    engine.restart(app).await;
    Ok(())
}

#[tauri::command]
pub async fn engine_logs(engine: State<'_, Engine>) -> CommandResult<Vec<String>> {
    Ok(engine.logs())
}

#[tauri::command]
pub async fn engine_settings(app: AppHandle) -> CommandResult<EngineSettings> {
    Ok(settings::load(&app))
}

/// Takes the invoke payload itself as the patch, so `{ path: null }` and `{}` stay distinct.
#[tauri::command]
pub async fn engine_set_settings(
    app: AppHandle,
    request: Request<'_>,
) -> CommandResult<EngineSettings> {
    let InvokeBody::Json(body) = request.body() else {
        return Err("engine_set_settings expects a JSON object".into());
    };
    let patch = SettingsPatch::deserialize(body).map_err(|error| error.to_string())?;
    settings::update(&app, patch)
}

#[tauri::command]
pub async fn app_info(app: AppHandle) -> CommandResult<AppInfo> {
    let paths = AppPaths::resolve(&app).map_err(|error| error.to_string())?;
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        log_dir: paths.logs,
        data_dir: paths.data,
        engines_dir: paths.engines,
        desktop_version: engine::desktop_version(),
        legacy_desktop: engine::legacy_desktop(&paths.local_data),
    })
}

/// Reveals `weft.log` in Explorer, or opens the empty log folder before anything was logged.
#[tauri::command]
pub async fn open_logs(app: AppHandle) -> CommandResult<()> {
    let paths = AppPaths::resolve(&app).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&paths.logs).map_err(|error| error.to_string())?;
    let log = paths.logs.join(applog::FILE_NAME);
    let opener = app.opener();
    if log.is_file() {
        opener.reveal_item_in_dir(&log)
    } else {
        opener.open_path(paths.logs.to_string_lossy(), None::<&str>)
    }
    .map_err(|error| error.to_string())
}

/// Writes text to the path the user picked in the save dialog.
#[tauri::command]
pub async fn save_text_file(path: String, contents: String) -> CommandResult<()> {
    let target = save_target(&path)?;
    tokio::fs::write(target, contents)
        .await
        .map_err(|error| format!("saving {}: {error}", target.display()))
}

fn save_target(path: &str) -> CommandResult<&Path> {
    let target = Path::new(path);
    if !target.is_absolute() {
        return Err(format!("{path} is not an absolute path"));
    }
    let Some(name) = target.file_name().and_then(|name| name.to_str()) else {
        return Err(format!("{path} does not name a file"));
    };
    // Windows drops trailing dots and spaces and reads `name:stream` as the file `name`, so `a.cmd.` is a.cmd.
    let trimmed = name.trim_end_matches(['.', ' ']);
    if trimmed != name || name.contains(':') {
        return Err(format!("{path} is not a name Windows keeps as written"));
    }
    let runnable = Path::new(trimmed)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| RUNNABLE.iter().any(|kind| kind.eq_ignore_ascii_case(extension)));
    if runnable {
        return Err(format!("Weft does not save files Windows would run: {path}"));
    }
    Ok(target)
}

#[tauri::command]
pub async fn observed_system(app: AppHandle, session_id: String) -> CommandResult<Option<Value>> {
    let paths = AppPaths::resolve(&app).map_err(|error| error.to_string())?;
    observed::read(&paths.observed, &session_id).await
}

#[cfg(test)]
mod tests {
    use super::save_target;

    #[test]
    fn saves_only_to_absolute_non_runnable_paths() {
        let export = std::env::temp_dir().join("weft-export.json");
        let export = export.to_str().unwrap();
        assert_eq!(save_target(export).unwrap().to_str(), Some(export));
        assert!(save_target("weft-export.json").is_err());
        assert!(save_target(r"..\weft-export.json").is_err());
        for name in ["weft-export.CMD", "a.cmd.", "a.cmd ", "a.json:x.cmd", "a.cmd::$DATA"] {
            let script = std::env::temp_dir().join(name);
            assert!(save_target(script.to_str().unwrap()).is_err(), "{name} must be refused");
        }
    }
}
