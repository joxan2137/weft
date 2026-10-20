use std::cmp::Ordering;

/// Versions become directory names, so only plain semver characters are accepted.
pub fn is_valid(version: &str) -> bool {
    !version.is_empty()
        && !version.contains("..")
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
}

pub fn compare(a: &str, b: &str) -> Ordering {
    let (a_core, a_pre) = split(a);
    let (b_core, b_pre) = split(b);
    a_core
        .cmp(&b_core)
        .then_with(|| b_pre.is_some().cmp(&a_pre.is_some()))
        .then_with(|| a_pre.cmp(&b_pre))
}

fn split(version: &str) -> (Vec<u64>, Option<&str>) {
    let version = version.split('+').next().unwrap_or_default();
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    };
    let numbers = core.split('.').map(|part| part.parse().unwrap_or(0)).collect();
    (numbers, pre)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_releases() {
        assert_eq!(compare("1.19.1", "1.3.13"), Ordering::Greater);
        assert_eq!(compare("1.19.1", "1.19.1"), Ordering::Equal);
        assert_eq!(compare("1.19.1-beta.1", "1.19.1"), Ordering::Less);
        assert_eq!(compare("2.0.0", "1.99.99"), Ordering::Greater);
    }

    #[test]
    fn rejects_path_like_versions() {
        assert!(is_valid("1.19.1"));
        assert!(!is_valid("../1.19.1"));
        assert!(!is_valid("1.19.1\\x"));
        assert!(!is_valid(""));
    }
}
