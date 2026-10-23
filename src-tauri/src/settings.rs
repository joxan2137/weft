use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE: &str = "settings.json";
const KEY: &str = "engine";
const PROXY_KEY: &str = "proxy";

const DEFAULT_MAX_LATENCY_MS: u64 = 2_000;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EngineSettings {
    pub path: Option<String>,
    pub allow_migrate: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProxySettings {
    pub enabled: bool,
    pub custom: Option<String>,
    pub max_latency_ms: u64,
}

impl Default for ProxySettings {
    fn default() -> Self {
        Self {
            enabled: false,
            custom: None,
            max_latency_ms: DEFAULT_MAX_LATENCY_MS,
        }
    }
}

impl EngineSettings {
    pub fn engine_path(&self) -> Option<PathBuf> {
        self.path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
    }
}

/// Partial update: an absent field is kept, `path: null` clears the custom engine.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(default, deserialize_with = "present")]
    path: Option<Option<String>>,
    #[serde(default)]
    allow_migrate: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPatch {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    pub custom: Option<Option<String>>,
    #[serde(default)]
    pub max_latency_ms: Option<u64>,
}

fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Option<String>>, D::Error> {
    Option::deserialize(deserializer).map(Some)
}

pub fn load(app: &AppHandle) -> EngineSettings {
    app.store(STORE)
        .ok()
        .and_then(|store| store.get(KEY))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

pub fn load_proxy(app: &AppHandle) -> ProxySettings {
    app.store(STORE)
        .ok()
        .and_then(|store| store.get(PROXY_KEY))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

pub fn update_proxy(app: &AppHandle, patch: ProxyPatch) -> Result<ProxySettings, String> {
    let mut settings = load_proxy(app);
    if let Some(enabled) = patch.enabled {
        settings.enabled = enabled;
    }
    if let Some(custom) = patch.custom {
        settings.custom = custom
            .map(|custom| custom.trim().to_owned())
            .filter(|custom| !custom.is_empty());
    }
    if let Some(max_latency_ms) = patch.max_latency_ms {
        settings.max_latency_ms = max_latency_ms.max(1);
    }
    let store = app.store(STORE).map_err(|error| error.to_string())?;
    store.set(PROXY_KEY, serde_json::to_value(&settings).map_err(|error| error.to_string())?);
    store.save().map_err(|error| error.to_string())?;
    Ok(settings)
}

pub fn update(app: &AppHandle, patch: SettingsPatch) -> Result<EngineSettings, String> {
    let mut settings = load(app);
    if let Some(path) = patch.path {
        let path = path.map(|path| path.trim().to_owned()).filter(|path| !path.is_empty());
        if let Some(path) = &path {
            check_engine_path(Path::new(path))?;
        }
        settings.path = path;
    }
    if let Some(allow_migrate) = patch.allow_migrate {
        settings.allow_migrate = allow_migrate;
    }
    let store = app.store(STORE).map_err(|error| error.to_string())?;
    store.set(KEY, serde_json::to_value(&settings).map_err(|error| error.to_string())?);
    store.save().map_err(|error| error.to_string())?;
    Ok(settings)
}

/// The webview may point Weft at an opencode binary, never at an arbitrary program.
fn check_engine_path(path: &Path) -> Result<(), String> {
    let named = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("opencode.exe") || name.eq_ignore_ascii_case("opencode"));
    if named && path.is_absolute() && path.is_file() {
        Ok(())
    } else {
        Err(format!("{} is not an existing opencode.exe", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_distinguishes_absent_from_null() {
        let absent: SettingsPatch = serde_json::from_str(r#"{"allowMigrate":true}"#).unwrap();
        assert_eq!(absent.path, None);
        assert_eq!(absent.allow_migrate, Some(true));

        let cleared: SettingsPatch = serde_json::from_str(r#"{"path":null}"#).unwrap();
        assert_eq!(cleared.path, Some(None));
    }

    #[test]
    fn proxy_patch_keeps_absent_fields_and_clears_custom_with_null() {
        let absent: ProxyPatch = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert_eq!(absent.enabled, Some(true));
        assert_eq!(absent.custom, None);

        let cleared: ProxyPatch = serde_json::from_str(r#"{"custom":null}"#).unwrap();
        assert_eq!(cleared.custom, Some(None));

        let defaults: ProxySettings = serde_json::from_str("{}").unwrap();
        assert_eq!(defaults.max_latency_ms, DEFAULT_MAX_LATENCY_MS);
    }

    #[test]
    fn accepts_only_an_existing_opencode_binary() {
        let root = std::env::temp_dir().join(format!("weft-settings-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(root.join("dir").join("opencode.exe")).unwrap();
        for name in ["opencode.exe", "OpenCode.exe", "opencode", "calc.exe"] {
            std::fs::write(root.join(name), b"").unwrap();
        }

        assert!(check_engine_path(&root.join("opencode.exe")).is_ok());
        assert!(check_engine_path(&root.join("OpenCode.exe")).is_ok());
        assert!(check_engine_path(&root.join("opencode")).is_ok());
        assert!(check_engine_path(&root.join("calc.exe")).is_err());
        assert!(check_engine_path(&root.join("missing").join("opencode.exe")).is_err());
        assert!(check_engine_path(&root.join("dir").join("opencode.exe")).is_err());
        assert!(check_engine_path(Path::new("opencode.exe")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
