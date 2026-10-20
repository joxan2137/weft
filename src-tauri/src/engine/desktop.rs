use std::path::{Path, PathBuf};

use serde::Serialize;

use super::version;

struct Install {
    version: String,
    location: Option<PathBuf>,
}

/// The retired Tauri build of OpenCode: its sidecar shares `opencode.db` and re-pins
/// `~/.config/opencode` to 1.3.x whenever it is launched.
#[derive(Clone, Debug, Serialize)]
pub struct LegacyDesktop {
    pub version: String,
    pub path: PathBuf,
}

/// Version of the installed OpenCode Desktop; the newest entry owns the schema of the shared DB.
pub fn installed_version() -> Option<String> {
    installs()
        .into_iter()
        .map(|install| install.version)
        .filter(|version| !is_legacy(version))
        .max_by(|a, b| version::compare(a, b))
}

pub fn legacy(local_data: &Path) -> Option<LegacyDesktop> {
    installs()
        .into_iter()
        .filter(|install| is_legacy(&install.version))
        .find_map(|install| {
            let path = install
                .location
                .unwrap_or_else(|| local_data.join("opencode"))
                .join("OpenCode.exe");
            path.is_file().then_some(LegacyDesktop {
                version: install.version,
                path,
            })
        })
}

fn is_legacy(version: &str) -> bool {
    version.starts_with("1.3.")
}

#[cfg(windows)]
fn installs() -> Vec<Install> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let Ok(uninstall) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Uninstall")
    else {
        return Vec::new();
    };
    uninstall
        .enum_keys()
        .flatten()
        .filter_map(|name| uninstall.open_subkey(name).ok())
        .filter(|key| {
            key.get_value::<String, _>("DisplayName")
                .is_ok_and(|name| name.contains("OpenCode"))
        })
        .filter_map(|key| {
            let version = key.get_value::<String, _>("DisplayVersion").ok()?;
            let location = key
                .get_value::<String, _>("InstallLocation")
                .ok()
                .map(|location| location.trim_matches('"').to_owned())
                .filter(|location| !location.is_empty())
                .map(PathBuf::from);
            version::is_valid(&version).then_some(Install { version, location })
        })
        .collect()
}

#[cfg(not(windows))]
fn installs() -> Vec<Install> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn treats_only_the_tauri_line_as_legacy() {
        assert!(is_legacy("1.3.13"));
        assert!(!is_legacy("1.19.1"));
        assert!(!is_legacy("1.30.0"));
    }
}
