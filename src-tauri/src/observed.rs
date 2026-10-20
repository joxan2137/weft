use std::io;
use std::path::Path;

use serde_json::Value;

/// Reads the system prompt the liberation plugin observed for a session, if it wrote one.
pub async fn read(dir: &Path, session_id: &str) -> Result<Option<Value>, String> {
    if !is_session_id(session_id) {
        return Err(format!("invalid session id {session_id:?}"));
    }
    let text = match tokio::fs::read_to_string(dir.join(format!("{session_id}.json"))).await {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn is_session_id(id: &str) -> bool {
    id.strip_prefix("ses_")
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_plain_session_ids() {
        assert!(is_session_id("ses_3f9aZ01"));
        assert!(!is_session_id("ses_"));
        assert!(!is_session_id("ses_../x"));
        assert!(!is_session_id("ses_a\\b"));
        assert!(!is_session_id("msg_abc"));
    }
}
