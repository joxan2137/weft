use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, ErrorCode, OpenFlags};

use super::probe;
use super::state::{ErrorKind, Failure, OrFail};

/// An engine that was just killed can still hold the DB's WAL and shared-memory files for a moment.
const RELEASE_RETRIES: u32 = 10;
const RELEASE_PAUSE: Duration = Duration::from_millis(300);

/// The `opencode.db` an engine with an unmodified XDG data dir opens, shared with OpenCode Desktop.
pub fn shared_db(home: &Path) -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .filter(|dir| !dir.is_empty())
        .map_or_else(|| home.join(".local").join("share"), PathBuf::from)
        .join("opencode")
        .join("opencode.db")
}

/// Starts an engine only on a DB that has exactly the migrations it knows: a newer engine would
/// migrate the DB underneath an older OpenCode Desktop, an older one would run on a schema it
/// does not know.
pub async fn guard(
    exe: &Path,
    version: &str,
    cache: &Path,
    db: &Path,
    allow_migrate: bool,
) -> Result<(), Failure> {
    if allow_migrate {
        return Ok(());
    }
    let path = db.to_path_buf();
    let applied = tauri::async_runtime::spawn_blocking(move || applied_once_released(&path))
        .await
        .or_fail(ErrorKind::MigrationCheck, "reading the opencode database")?
        .or_fail(ErrorKind::MigrationCheck, "reading the opencode database")?;
    let Some(applied) = applied else {
        return Ok(());
    };

    let skew = Skew::between(&known(exe, cache).await?, &applied);
    if let Some(newest) = skew.unknown.last() {
        return Err(Failure::new(
            ErrorKind::DbNewerThanEngine,
            format!(
                "{} has {} migration(s) that opencode {version} does not know (newest: {newest}). \
                 Use a newer engine, or turn on \"Allow this engine to migrate the database\" in \
                 Settings › Engine to start it anyway.",
                db.display(),
                skew.unknown.len()
            ),
        ));
    }
    match skew.missing.last() {
        None => Ok(()),
        Some(newest) => Err(Failure::new(
            ErrorKind::EngineNewerThanDb,
            format!(
                "opencode {version} would apply {} migration(s) that {} does not have yet \
                 (newest: {newest}). Turn on \"Allow this engine to migrate the database\" in \
                 Settings › Engine to let it upgrade the database.",
                skew.missing.len(),
                db.display()
            ),
        )),
    }
}

/// The DB's migration journal. Installs from before 1.19 only have Drizzle's
/// `__drizzle_migrations`, which the engine adopts on its first start: by name, or by the
/// `YYYYMMDDHHMMSS` of `created_at` matched against its own ids.
#[derive(Default)]
struct Applied {
    ids: HashSet<String>,
    timestamps: Vec<String>,
}

#[derive(Debug, Default, PartialEq)]
struct Skew {
    /// Known to the engine but not applied: the engine would apply them.
    missing: Vec<String>,
    /// Applied but unknown to the engine: the DB is newer than the engine.
    unknown: Vec<String>,
}

impl Skew {
    fn between(known: &[String], applied: &Applied) -> Self {
        let mut done: HashSet<&str> = applied.ids.iter().map(String::as_str).collect();
        let mut unknown: Vec<String> = applied
            .ids
            .iter()
            .filter(|id| !known.contains(id))
            .cloned()
            .collect();
        for timestamp in &applied.timestamps {
            let prefix = format!("{timestamp}_");
            match known.iter().find(|id| id.starts_with(&prefix)) {
                Some(id) => {
                    done.insert(id);
                }
                None => unknown.push(timestamp.clone()),
            }
        }
        unknown.sort();
        let missing = known
            .iter()
            .filter(|id| !done.contains(id.as_str()))
            .cloned()
            .collect();
        Self { missing, unknown }
    }
}

/// `None` when the DB does not exist or has no `session` table, so there is nothing to migrate.
fn applied_once_released(db: &Path) -> rusqlite::Result<Option<Applied>> {
    let mut retries = 0;
    loop {
        match applied(db) {
            Err(rusqlite::Error::SqliteFailure(error, _))
                if retries < RELEASE_RETRIES
                    && matches!(
                        error.code,
                        ErrorCode::SystemIoFailure | ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
                    ) =>
            {
                retries += 1;
                std::thread::sleep(RELEASE_PAUSE);
            }
            result => return result,
        }
    }
}

fn applied(db: &Path) -> rusqlite::Result<Option<Applied>> {
    if !db.is_file() {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    if !has_table(&conn, "session")? {
        return Ok(None);
    }
    let mut applied = Applied::default();
    if has_table(&conn, "migration")? {
        applied.ids = strings(&conn, "select id from migration")?.into_iter().collect();
    }
    if applied.ids.is_empty() && has_table(&conn, "__drizzle_migrations")? {
        let named: bool = conn.query_row(
            "select exists(select 1 from pragma_table_info('__drizzle_migrations') where name = 'name')",
            [],
            |row| row.get(0),
        )?;
        if named {
            applied.ids = strings(
                &conn,
                "select name from __drizzle_migrations where name is not null",
            )?
            .into_iter()
            .collect();
        } else {
            applied.timestamps = strings(
                &conn,
                "select coalesce(strftime('%Y%m%d%H%M%S', created_at / 1000, 'unixepoch'), \
                 cast(created_at as text)) from __drizzle_migrations where created_at is not null",
            )?;
        }
    }
    Ok(Some(applied))
}

fn has_table(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "select exists(select 1 from sqlite_master where type = 'table' and name = ?1)",
        [name],
        |row| row.get(0),
    )
}

fn strings(conn: &Connection, sql: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare(sql)?;
    statement.query_map([], |row| row.get(0))?.collect()
}

async fn known(exe: &Path, cache: &Path) -> Result<Vec<String>, Failure> {
    if let Ok(text) = tokio::fs::read_to_string(cache).await
        && let Ok(ids) = serde_json::from_str(&text)
    {
        return Ok(ids);
    }
    let ids = probe::migrations(exe).await?;
    if let Some(dir) = cache.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    if let Ok(json) = serde_json::to_vec(&ids) {
        let _ = tokio::fs::write(cache, json).await;
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOWN: &str = r#"["20260101000000_a","20260102000000_b","20260103000000_c"]"#;
    /// `created_at` of a Drizzle journal entry for `20260101000000_a`.
    const A_CREATED_AT: i64 = 1_767_225_600_000;

    struct Fixture {
        root: PathBuf,
        cache: PathBuf,
        db: PathBuf,
    }

    impl Fixture {
        fn new(schema: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("weft-guard-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&root).unwrap();
            let cache = root.join("migrations.json");
            std::fs::write(&cache, KNOWN).unwrap();
            let db = root.join("opencode.db");
            Connection::open(&db).unwrap().execute_batch(schema).unwrap();
            Self { root, cache, db }
        }

        fn with_migrations(ids: &[&str]) -> Self {
            let fixture = Self::new(
                "create table session (id text primary key);
                 create table migration (id text primary key, time_completed integer not null);",
            );
            let conn = Connection::open(&fixture.db).unwrap();
            for id in ids {
                conn.execute("insert into migration (id, time_completed) values (?1, 0)", [id])
                    .unwrap();
            }
            fixture
        }

        fn check(&self, allow_migrate: bool) -> Result<(), ErrorKind> {
            let exe = Path::new("unused-when-cached.exe");
            tauri::async_runtime::block_on(guard(exe, "9.9.9", &self.cache, &self.db, allow_migrate))
                .map_err(|failure| failure.kind)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn accepts_a_db_at_the_engine_schema() {
        let fixture = Fixture::with_migrations(&["20260101000000_a", "20260102000000_b", "20260103000000_c"]);
        assert_eq!(fixture.check(false), Ok(()));
    }

    #[test]
    fn blocks_an_engine_newer_than_the_db() {
        let fixture = Fixture::with_migrations(&["20260101000000_a", "20260102000000_b"]);
        assert_eq!(fixture.check(false), Err(ErrorKind::EngineNewerThanDb));
        assert_eq!(fixture.check(true), Ok(()));
    }

    #[test]
    fn blocks_an_engine_older_than_the_db() {
        let fixture = Fixture::with_migrations(&[
            "20260101000000_a",
            "20260102000000_b",
            "20260103000000_c",
            "20260104000000_future",
        ]);
        assert_eq!(fixture.check(false), Err(ErrorKind::DbNewerThanEngine));
        assert_eq!(fixture.check(true), Ok(()));
    }

    #[test]
    fn lets_the_engine_create_a_db_that_is_missing_or_empty() {
        let fixture = Fixture::new("");
        assert_eq!(fixture.check(false), Ok(()));
        std::fs::remove_file(&fixture.db).unwrap();
        assert_eq!(fixture.check(false), Ok(()));
    }

    #[test]
    fn blocks_a_db_with_sessions_but_no_journal() {
        let fixture = Fixture::new("create table session (id text primary key);");
        assert_eq!(fixture.check(false), Err(ErrorKind::EngineNewerThanDb));
    }

    #[test]
    fn reads_a_named_drizzle_journal() {
        let fixture = Fixture::new(
            "create table session (id text primary key);
             create table __drizzle_migrations (id integer primary key, hash text, created_at numeric, name text);
             insert into __drizzle_migrations (hash, created_at, name) values
               ('x', 0, '20260101000000_a'), ('y', 0, '20260102000000_b');",
        );
        assert_eq!(fixture.check(false), Err(ErrorKind::EngineNewerThanDb));
    }

    #[test]
    fn maps_an_unnamed_drizzle_journal_by_timestamp() {
        let journal = |created: &[i64]| {
            let rows: Vec<String> = created.iter().map(|at| format!("('h', {at})")).collect();
            Fixture::new(&format!(
                "create table session (id text primary key);
                 create table migration (id text primary key, time_completed integer not null);
                 create table __drizzle_migrations (id integer primary key, hash text, created_at numeric);
                 insert into __drizzle_migrations (hash, created_at) values {};",
                rows.join(", ")
            ))
        };
        let day = 86_400_000;
        let behind = journal(&[A_CREATED_AT]);
        assert_eq!(behind.check(false), Err(ErrorKind::EngineNewerThanDb));
        let exact = journal(&[A_CREATED_AT, A_CREATED_AT + day, A_CREATED_AT + 2 * day]);
        assert_eq!(exact.check(false), Ok(()));
        let ahead = journal(&[A_CREATED_AT, A_CREATED_AT + day, A_CREATED_AT + 2 * day, A_CREATED_AT + 9 * day]);
        assert_eq!(ahead.check(false), Err(ErrorKind::DbNewerThanEngine));
    }
}
