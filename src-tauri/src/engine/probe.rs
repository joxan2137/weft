use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use tokio::process::Command;
use uuid::Uuid;

use super::state::{ErrorKind, Failure, OrFail};
use super::version;

const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

pub async fn version(exe: &Path) -> Result<String, Failure> {
    let output = run(exe, &["--version"], ErrorKind::Resolve).await?;
    let reported = output.trim();
    if version::is_valid(reported) {
        Ok(reported.to_owned())
    } else {
        Err(Failure::new(
            ErrorKind::Resolve,
            format!("{} --version printed {reported:?}", exe.display()),
        ))
    }
}

/// Migration ids the engine knows, read from a fresh DB it creates and fully migrates.
pub async fn migrations(exe: &Path) -> Result<Vec<String>, Failure> {
    #[derive(Deserialize)]
    struct Row {
        id: String,
    }

    let output = run(
        exe,
        &["db", "select id from migration order by id", "--format", "json"],
        ErrorKind::MigrationCheck,
    )
    .await?;
    let json = output.find('[').map_or("", |start| &output[start..]);
    let rows: Vec<Row> = serde_json::from_str(json)
        .or_fail(ErrorKind::MigrationCheck, "reading the engine's migration list")?;
    Ok(rows.into_iter().map(|row| row.id).collect())
}

/// Throwaway XDG and DB locations so a probe never writes into the user's opencode data.
struct Sandbox(PathBuf);

impl Sandbox {
    fn create() -> std::io::Result<Self> {
        let dir = std::env::temp_dir().join(format!("weft-probe-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir)?;
        Ok(Self(dir))
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn run(exe: &Path, args: &[&str], kind: ErrorKind) -> Result<String, Failure> {
    let sandbox = Sandbox::create().or_fail(kind, "creating a probe sandbox")?;
    let root = &sandbox.0;
    let mut command = Command::new(exe);
    command
        .args(args)
        .current_dir(root)
        .env("XDG_DATA_HOME", root.join("data"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env("OPENCODE_DB", root.join("probe.db"))
        .env("OPENCODE_DISABLE_AUTOUPDATE", "1")
        .env_remove("OPENCODE_CONFIG_DIR")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(windows::Win32::System::Threading::CREATE_NO_WINDOW.0);

    let doing = format!("running {} {}", exe.display(), args.join(" "));
    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output())
        .await
        .or_fail(kind, &doing)?
        .or_fail(kind, &doing)?;
    if !output.status.success() {
        return Err(Failure::new(
            kind,
            format!(
                "{doing} failed ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::async_runtime::block_on;

    #[test]
    #[ignore = "needs WEFT_TEST_ENGINE"]
    fn reads_version_and_migrations_from_a_real_engine() {
        let exe = PathBuf::from(std::env::var_os("WEFT_TEST_ENGINE").unwrap());
        assert!(version::is_valid(&block_on(version(&exe)).unwrap()));
        let ids = block_on(migrations(&exe)).unwrap();
        assert!(!ids.is_empty());
        assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
