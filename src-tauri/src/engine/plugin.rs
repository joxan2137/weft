use std::fs;
use std::io;
use std::path::Path;

use serde_json::json;
use tauri::Url;

pub const FILE: &str = "weft-liberated.ts";
/// The `workflow` tool, a plugin of its own so liberation never depends on it.
pub const WORKFLOW_FILE: &str = "weft-workflow.ts";
pub const CANARY: &str = "weft_canary";

pub fn copy_bundled(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            fs::copy(entry.path(), to.join(entry.file_name()))?;
        }
    }
    Ok(())
}

/// `OPENCODE_CONFIG_CONTENT` is merged after every config dir, so the plugin loads last while the
/// user's global config and `AGENTS.md` stay in effect; an app-owned `OPENCODE_CONFIG_DIR` would
/// replace them. Denying the canary keeps it out of model requests but listed in tool ids.
pub fn config_content(plugin_dir: &Path) -> Option<String> {
    let url = |file: &str| Url::from_file_path(plugin_dir.join(file)).ok().map(String::from);
    Some(json!({ "plugin": [url(FILE)?, url(WORKFLOW_FILE)?], "permission": { CANARY: "deny" } }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn points_the_engine_at_the_copied_plugin() {
        let content = config_content(Path::new(r"C:\Users\A User\AppData\Roaming\app.weft.desktop\plugins")).unwrap();
        let config: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(
            config["plugin"][0],
            "file:///C:/Users/A%20User/AppData/Roaming/app.weft.desktop/plugins/weft-liberated.ts"
        );
        assert_eq!(
            config["plugin"][1],
            "file:///C:/Users/A%20User/AppData/Roaming/app.weft.desktop/plugins/weft-workflow.ts"
        );
        assert_eq!(config["permission"][CANARY], "deny");
    }

    #[test]
    fn copies_bundled_files() {
        let root = std::env::temp_dir().join(format!("weft-plugin-{}", uuid::Uuid::new_v4().simple()));
        let bundled = root.join("bundled");
        fs::create_dir_all(&bundled).unwrap();
        fs::write(bundled.join(FILE), "export {}").unwrap();

        copy_bundled(&bundled, &root.join("plugins")).unwrap();

        assert!(root.join("plugins").join(FILE).is_file());
        fs::remove_dir_all(root).unwrap();
    }
}
