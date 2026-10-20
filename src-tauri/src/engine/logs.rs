use std::collections::VecDeque;
use std::sync::Mutex;

use crate::applog;

const CAPACITY: usize = 400;

/// The engine's recent output for Settings › Engine; every line also goes to `weft.log`.
#[derive(Default)]
pub struct LogRing {
    lines: Mutex<VecDeque<String>>,
}

impl LogRing {
    pub fn push(&self, line: String) {
        applog::line("engine", &line);
        let mut lines = self.lines.lock().unwrap();
        if lines.len() == CAPACITY {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    pub fn snapshot(&self) -> Vec<String> {
        self.lines.lock().unwrap().iter().cloned().collect()
    }

    pub fn tail(&self, count: usize) -> Vec<String> {
        let lines = self.lines.lock().unwrap();
        lines.iter().skip(lines.len().saturating_sub(count)).cloned().collect()
    }
}
