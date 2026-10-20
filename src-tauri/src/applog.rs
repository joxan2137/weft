use std::fmt::Display;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError, TryLockError};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FILE_NAME: &str = "weft.log";
const ROTATED_NAME: &str = "weft.old.log";
const ROTATE_AT: u64 = 5 * 1024 * 1024;

static LOG: OnceLock<LogFile> = OnceLock::new();

/// Opens `weft.log` in `dir` for the rest of the process; the first folder that opens wins.
pub fn init(dir: &Path) {
    if LOG.get().is_some() {
        return;
    }
    match LogFile::open(dir, ROTATE_AT) {
        Ok(log) => {
            let _ = LOG.set(log);
        }
        Err(error) => eprintln!("weft: cannot open the log in {}: {error}", dir.display()),
    }
}

pub fn line(source: &str, text: impl Display) {
    if let Some(log) = LOG.get() {
        log.append(&entry(SystemTime::now(), source, text));
    }
}

/// Writes the panic to the log before the default hook runs and `panic = "abort"` ends Weft.
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(log) = LOG.get() {
            log.append_unless_busy(&entry(SystemTime::now(), "panic", info));
        }
        default_hook(info);
    }));
}

fn entry(time: SystemTime, source: &str, text: impl Display) -> String {
    format!("{} {source}: {text}\n", timestamp(time))
}

struct LogFile {
    dir: PathBuf,
    rotate_at: u64,
    writer: Mutex<Writer>,
}

struct Writer {
    file: Option<File>,
    size: u64,
}

impl LogFile {
    fn open(dir: &Path, rotate_at: u64) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let file = open_append(&dir.join(FILE_NAME))?;
        let size = file.metadata()?.len();
        Ok(Self {
            dir: dir.to_owned(),
            rotate_at,
            writer: Mutex::new(Writer {
                file: Some(file),
                size,
            }),
        })
    }

    fn append(&self, entry: &str) {
        let writer = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
        self.write(writer, entry);
    }

    /// A panic raised while this thread holds the lock must not deadlock its own hook.
    fn append_unless_busy(&self, entry: &str) {
        match self.writer.try_lock() {
            Ok(writer) => self.write(writer, entry),
            Err(TryLockError::Poisoned(poisoned)) => self.write(poisoned.into_inner(), entry),
            Err(TryLockError::WouldBlock) => {}
        }
    }

    /// Moves a full `weft.log` to `weft.old.log`; if that fails the file keeps growing until the
    /// next limit rather than retrying on every line.
    fn write(&self, mut guard: MutexGuard<'_, Writer>, entry: &str) {
        let writer = &mut *guard;
        if writer.size > 0 && writer.size + entry.len() as u64 > self.rotate_at {
            let current = self.dir.join(FILE_NAME);
            writer.file = None;
            let _ = fs::rename(&current, self.dir.join(ROTATED_NAME));
            writer.file = open_append(&current).ok();
            writer.size = 0;
        }
        if let Some(file) = &mut writer.file
            && file.write_all(entry.as_bytes()).is_ok()
        {
            writer.size += entry.len() as u64;
        }
    }
}

fn open_append(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

/// UTC, as `2026-10-16T14:44:05.123Z`.
fn timestamp(time: SystemTime) -> String {
    let since_epoch = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since_epoch.as_secs();
    let (year, month, day) = civil_date((seconds / 86_400) as i64);
    let of_day = seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3600,
        of_day / 60 % 60,
        of_day % 60,
        since_epoch.subsec_millis()
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's `civil_from_days`).
fn civil_date(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_index + 2) / 5 + 1) as u32;
    let month = (if month_index < 10 { month_index + 3 } else { month_index - 9 }) as u32;
    (year_of_era + era * 400 + i64::from(month <= 2), month, day)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn stamps_utc_dates_across_leap_days() {
        let at = |millis| UNIX_EPOCH + Duration::from_millis(millis);
        assert_eq!(timestamp(at(0)), "1970-01-01T00:00:00.000Z");
        assert_eq!(timestamp(at(951_782_400_000)), "2000-02-29T00:00:00.000Z");
        assert_eq!(timestamp(at(1_792_161_845_123)), "2026-10-16T14:44:05.123Z");
    }

    #[test]
    fn rotates_the_log_into_one_old_file() {
        let dir = std::env::temp_dir().join(format!("weft-log-{}", uuid::Uuid::new_v4().simple()));
        let log = LogFile::open(&dir, 64).unwrap();
        let read = |name| fs::read_to_string(dir.join(name)).unwrap_or_default();

        log.append(&"a".repeat(40));
        log.append(&"b".repeat(40));
        assert_eq!(read(FILE_NAME), "b".repeat(40));
        assert_eq!(read(ROTATED_NAME), "a".repeat(40));

        log.append(&"c".repeat(20));
        log.append_unless_busy(&"d".repeat(40));
        assert_eq!(read(FILE_NAME), "d".repeat(40));
        assert_eq!(read(ROTATED_NAME), format!("{}{}", "b".repeat(40), "c".repeat(20)));

        drop(log);
        let reopened = LogFile::open(&dir, 64).unwrap();
        assert_eq!(reopened.writer.lock().unwrap().size, 40);
        drop(reopened);
        fs::remove_dir_all(dir).unwrap();
    }
}
