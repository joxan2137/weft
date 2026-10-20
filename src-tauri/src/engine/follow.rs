use std::time::Duration;

use super::state::EngineState;

const RETRY_FIRST: Duration = Duration::from_secs(30);
const RETRY_MAX: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// A launch is under way, or it failed for the Desktop version installed now.
    Keep,
    /// The engine already runs Desktop's version, or there is no Desktop to follow.
    Settled,
    /// Prepare Desktop's version while the running engine serves, then swap.
    Switch(String),
    /// Nothing is serving and Desktop moved on: launch for it right away.
    Relaunch,
}

/// What follows from OpenCode Desktop being at `installed` while the engine, launched to follow
/// Desktop `launched_for`, is in `state`.
pub fn decide(state: &EngineState, launched_for: Option<&str>, installed: Option<&str>) -> Decision {
    let Some(installed) = installed else {
        return Decision::Settled;
    };
    match state {
        EngineState::Ready { version, .. } if version == installed => Decision::Settled,
        EngineState::Ready { .. } => Decision::Switch(installed.to_owned()),
        EngineState::Error { .. } if launched_for != Some(installed) => Decision::Relaunch,
        _ => Decision::Keep,
    }
}

pub struct Backoff(Duration);

impl Default for Backoff {
    fn default() -> Self {
        Self(RETRY_FIRST)
    }
}

impl Backoff {
    pub fn next(&mut self) -> Duration {
        let delay = self.0;
        self.0 = (delay * 2).min(RETRY_MAX);
        delay
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::state::{ErrorKind, Failure};

    fn ready(version: &str) -> EngineState {
        EngineState::Ready {
            url: "http://127.0.0.1:1".into(),
            username: "weft".into(),
            password: "p".into(),
            version: version.into(),
            notice: None,
        }
    }

    fn failed() -> EngineState {
        Failure::new(ErrorKind::Exited, "gone").into()
    }

    #[test]
    fn switches_a_serving_engine_to_the_installed_desktop() {
        assert_eq!(decide(&ready("1.19.1"), Some("1.19.1"), Some("1.19.1")), Decision::Settled);
        assert_eq!(
            decide(&ready("1.19.1"), Some("1.19.1"), Some("1.20.0")),
            Decision::Switch("1.20.0".into())
        );
        assert_eq!(
            decide(&ready("1.19.1"), Some("1.20.0"), Some("1.20.0")),
            Decision::Switch("1.20.0".into())
        );
        assert_eq!(
            decide(&ready("1.20.0"), Some("1.20.0"), Some("1.19.1")),
            Decision::Switch("1.19.1".into())
        );
        assert_eq!(
            decide(&ready("1.19.1"), None, Some("1.20.0")),
            Decision::Switch("1.20.0".into())
        );
        assert_eq!(decide(&ready("1.19.1"), Some("1.19.1"), None), Decision::Settled);
    }

    #[test]
    fn relaunches_a_failed_engine_only_when_desktop_moved() {
        assert_eq!(decide(&failed(), Some("1.19.1"), Some("1.20.0")), Decision::Relaunch);
        assert_eq!(decide(&failed(), None, Some("1.19.1")), Decision::Relaunch);
        assert_eq!(decide(&failed(), Some("1.19.1"), Some("1.19.1")), Decision::Keep);
        assert_eq!(decide(&failed(), Some("1.19.1"), None), Decision::Settled);
    }

    #[test]
    fn leaves_a_launch_in_progress_alone() {
        for state in [
            EngineState::Idle,
            EngineState::Resolving,
            EngineState::Starting { version: "1.19.1".into() },
        ] {
            assert_eq!(decide(&state, Some("1.19.1"), Some("1.20.0")), Decision::Keep);
        }
    }

    #[test]
    fn backs_off_up_to_five_minutes() {
        let mut backoff = Backoff::default();
        let delays: Vec<u64> = (0..6).map(|_| backoff.next().as_secs()).collect();
        assert_eq!(delays, [30, 60, 120, 240, 300, 300]);
    }
}
