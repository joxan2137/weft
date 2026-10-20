use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use reqwest::Client;
use sha2::{Digest, Sha512};
use tokio::io::AsyncWriteExt;

use super::npm;
use super::state::{ErrorKind, Failure, OrFail};
use super::version;

pub const EXE: &str = "opencode.exe";
const TARBALL: &str = "opencode.tgz.partial";
const EXE_PARTIAL: &str = "opencode.exe.partial";
const TARBALL_ENTRY: &str = "package/bin/opencode.exe";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

pub async fn ensure(
    client: &Client,
    dir: &Path,
    version: &str,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<PathBuf, Failure> {
    let exe = dir.join(EXE);
    if exe.is_file() {
        return Ok(exe);
    }
    tokio::fs::create_dir_all(dir)
        .await
        .or_fail(ErrorKind::Install, "creating the engine directory")?;

    let dist = npm::dist(client, version).await?;
    let tarball = dir.join(TARBALL);
    let verified = match download(client, &dist.tarball, &tarball, &mut progress).await {
        Ok(digest) => verify(&dist.integrity, &digest),
        Err(failure) => Err(failure),
    };
    if let Err(failure) = verified {
        let _ = tokio::fs::remove_file(&tarball).await;
        return Err(failure);
    }

    let target = exe.clone();
    let source = tarball.clone();
    let extracted = tauri::async_runtime::spawn_blocking(move || extract(&source, &target))
        .await
        .or_fail(ErrorKind::Install, "extracting opencode.exe")
        .and_then(|result| result.or_fail(ErrorKind::Install, "extracting opencode.exe"));
    let _ = tokio::fs::remove_file(&tarball).await;
    extracted.map(|()| exe)
}

/// Installed engine versions, newest first.
pub fn installed(engines: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(engines) else {
        return Vec::new();
    };
    let mut versions: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().join(EXE).is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| version::is_valid(name))
        .collect();
    versions.sort_by(|a, b| version::compare(b, a));
    versions
}

/// Deletes every engine version not in `keep`, and the leftovers of an aborted download next to
/// a kept engine. A version whose exe is still running cannot be deleted and waits for the next
/// prune.
pub fn prune(engines: &Path, keep: &[String]) {
    let Ok(entries) = fs::read_dir(engines) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let kept = entry
            .file_name()
            .to_str()
            .is_some_and(|name| keep.iter().any(|version| version == name));
        if !kept {
            let exe = dir.join(EXE);
            if !exe.exists() || fs::remove_file(&exe).is_ok() {
                let _ = fs::remove_dir_all(&dir);
            }
        } else if dir.join(EXE).is_file() {
            let _ = fs::remove_file(dir.join(TARBALL));
            let _ = fs::remove_file(dir.join(EXE_PARTIAL));
        }
    }
}

/// Moves the engines an earlier build kept in `legacy` into `engines`, keeping a complete engine
/// that is already there, then removes `legacy` and its parent when that is left empty. An engine
/// that cannot move (its exe still running) keeps `legacy` in place for the next start.
pub fn adopt_legacy(legacy: &Path, engines: &Path) -> io::Result<()> {
    let entries = match fs::read_dir(legacy) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    fs::create_dir_all(engines)?;
    for entry in entries.flatten() {
        let target = engines.join(entry.file_name());
        if entry.path().join(EXE).is_file() && !target.join(EXE).is_file() {
            if target.exists() {
                fs::remove_dir_all(&target)?;
            }
            fs::rename(entry.path(), &target)?;
        }
    }
    fs::remove_dir_all(legacy)?;
    if let Some(parent) = legacy.parent() {
        let _ = fs::remove_dir(parent);
    }
    Ok(())
}

async fn download(
    client: &Client,
    url: &str,
    dest: &Path,
    progress: &mut impl FnMut(u64, Option<u64>),
) -> Result<Vec<u8>, Failure> {
    let doing = format!("downloading {url}");
    let mut response = client
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| npm::failure(ErrorKind::Install, &doing, error))?;
    let total = response.content_length();
    let mut file = tokio::fs::File::create(dest)
        .await
        .or_fail(ErrorKind::Install, "creating the download file")?;
    let mut hasher = Sha512::new();
    let mut received = 0;
    let mut reported = Instant::now();
    progress(received, total);

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| npm::failure(ErrorKind::Install, &doing, error))?
    {
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .or_fail(ErrorKind::Install, "writing the download")?;
        received += chunk.len() as u64;
        if reported.elapsed() >= PROGRESS_INTERVAL {
            progress(received, total);
            reported = Instant::now();
        }
    }
    file.flush()
        .await
        .or_fail(ErrorKind::Install, "writing the download")?;
    progress(received, total);
    Ok(hasher.finalize().to_vec())
}

fn verify(integrity: &str, digest: &[u8]) -> Result<(), Failure> {
    let encoded = integrity
        .split_whitespace()
        .find_map(|entry| entry.strip_prefix("sha512-"))
        .ok_or_else(|| {
            Failure::new(
                ErrorKind::Integrity,
                format!("the registry gave no sha512 integrity ({integrity})"),
            )
        })?;
    let expected = STANDARD
        .decode(encoded)
        .or_fail(ErrorKind::Integrity, "decoding the sha512 integrity")?;
    if expected == digest {
        Ok(())
    } else {
        Err(Failure::new(
            ErrorKind::Integrity,
            "the downloaded engine does not match its npm sha512 integrity",
        ))
    }
}

fn extract(tarball: &Path, exe: &Path) -> io::Result<()> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(File::open(tarball)?));
    for entry in archive.entries()? {
        let mut entry = entry?;
        if entry.path_bytes().as_ref() != TARBALL_ENTRY.as_bytes() {
            continue;
        }
        let partial = exe.with_file_name(EXE_PARTIAL);
        {
            let mut out = File::create(&partial)?;
            io::copy(&mut entry, &mut out)?;
            out.sync_all()?;
        }
        return fs::rename(&partial, exe);
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!("{TARBALL_ENTRY} is missing from the tarball"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_sri_sha512() {
        let digest = Sha512::digest(b"weft").to_vec();
        let integrity = format!("sha512-{}", STANDARD.encode(&digest));
        assert!(verify(&integrity, &digest).is_ok());
        assert_eq!(
            verify(&integrity, &[0; 64]).unwrap_err().kind,
            ErrorKind::Integrity
        );
        assert!(verify("sha1-abc", &digest).is_err());
    }

    #[test]
    fn prunes_all_but_the_kept_versions() {
        let engines =
            std::env::temp_dir().join(format!("weft-engines-{}", uuid::Uuid::new_v4().simple()));
        let seed = |version: &str, files: &[&str]| {
            let dir = engines.join(version);
            fs::create_dir_all(&dir).unwrap();
            for file in files {
                fs::write(dir.join(file), b"x").unwrap();
            }
        };
        seed("1.18.0", &[EXE, "migrations.json"]);
        seed("1.19.1", &[EXE, TARBALL]);
        seed("1.19.10", &[EXE]);
        seed("1.20.0", &[TARBALL]);
        assert_eq!(installed(&engines), ["1.19.10", "1.19.1", "1.18.0"]);

        prune(&engines, &["1.19.1".to_owned(), "1.20.0".to_owned()]);

        assert!(!engines.join("1.18.0").exists());
        assert!(!engines.join("1.19.10").exists());
        assert!(engines.join("1.19.1").join(EXE).is_file());
        assert!(!engines.join("1.19.1").join(TARBALL).exists());
        assert!(engines.join("1.20.0").join(TARBALL).is_file());
        fs::remove_dir_all(engines).unwrap();
    }

    #[test]
    fn adopts_legacy_engines_without_replacing_complete_ones() {
        let root =
            std::env::temp_dir().join(format!("weft-adopt-{}", uuid::Uuid::new_v4().simple()));
        let legacy = root.join("Weft").join("engines");
        let engines = root.join("app.weft.desktop").join("engines");
        let seed = |dir: &Path, version: &str, file: &str, contents: &str| {
            fs::create_dir_all(dir.join(version)).unwrap();
            fs::write(dir.join(version).join(file), contents).unwrap();
        };
        seed(&legacy, "1.19.1", EXE, "legacy");
        seed(&legacy, "1.19.2", EXE, "legacy");
        seed(&legacy, "1.20.0", EXE, "legacy");
        seed(&legacy, "1.21.0", TARBALL, "legacy");
        seed(&engines, "1.19.2", EXE, "current");
        seed(&engines, "1.20.0", TARBALL, "current");

        adopt_legacy(&legacy, &engines).unwrap();

        let exe = |version: &str| fs::read_to_string(engines.join(version).join(EXE)).ok();
        assert_eq!(exe("1.19.1").as_deref(), Some("legacy"));
        assert_eq!(exe("1.19.2").as_deref(), Some("current"));
        assert_eq!(exe("1.20.0").as_deref(), Some("legacy"));
        assert!(!engines.join("1.20.0").join(TARBALL).exists());
        assert!(!engines.join("1.21.0").exists());
        assert!(!root.join("Weft").exists());
        assert!(adopt_legacy(&legacy, &engines).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}
