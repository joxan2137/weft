use std::fmt::Display;

use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EngineState {
    #[default]
    Idle,
    Resolving,
    Installing {
        version: String,
        received: u64,
        total: Option<u64>,
    },
    Starting {
        version: String,
    },
    Ready {
        url: String,
        username: String,
        password: String,
        version: String,
        /// A pending switch to an updated OpenCode Desktop's engine, or why a newer engine was skipped.
        #[serde(skip_serializing_if = "Option::is_none")]
        notice: Option<String>,
    },
    Error {
        message: String,
        kind: ErrorKind,
    },
}

impl EngineState {
    /// What `weft.log` keeps of a state change: download progress only once, never the password.
    pub fn summary(&self) -> Option<String> {
        match self {
            Self::Idle => None,
            Self::Resolving => Some("resolving the engine version".to_owned()),
            Self::Installing {
                version,
                received: 0,
                ..
            } => Some(format!("installing opencode {version}")),
            Self::Installing { .. } => None,
            Self::Starting { version } => Some(format!("starting opencode {version}")),
            Self::Ready {
                url,
                version,
                notice,
                ..
            } => Some(match notice {
                Some(notice) => format!("opencode {version} ready at {url}; {notice}"),
                None => format!("opencode {version} ready at {url}"),
            }),
            Self::Error { message, kind } => Some(format!("engine error ({kind:?}): {message}")),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    Resolve,
    Install,
    Integrity,
    MigrationCheck,
    EngineNewerThanDb,
    DbNewerThanEngine,
    Config,
    Start,
    Timeout,
    VersionMismatch,
    Exited,
}

#[derive(Debug)]
pub struct Failure {
    pub kind: ErrorKind,
    pub message: String,
}

impl Failure {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl From<Failure> for EngineState {
    fn from(failure: Failure) -> Self {
        Self::Error {
            message: failure.message,
            kind: failure.kind,
        }
    }
}

pub trait OrFail<T> {
    fn or_fail(self, kind: ErrorKind, doing: &str) -> Result<T, Failure>;
}

impl<T, E: Display> OrFail<T> for Result<T, E> {
    fn or_fail(self, kind: ErrorKind, doing: &str) -> Result<T, Failure> {
        self.map_err(|error| Failure::new(kind, format!("{doing}: {error}")))
    }
}
