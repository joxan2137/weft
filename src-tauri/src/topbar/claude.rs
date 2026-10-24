#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

const TAIL_BYTES: u64 = 512 * 1024;
const MAX_READ: u64 = 1024 * 1024;
const MAX_LINE: usize = 2 * 1024 * 1024;
const MAX_ROWS: usize = 64;
const ACTIVE_WINDOW_MS: u64 = 20 * 60 * 1000;
const INACTIVE_WINDOW_MS: u64 = 30 * 60 * 1000;
const DONE_QUIET_MS: u64 = 1200;
const DONE_SILENCE_MS: u64 = 10_000;
const CLEAR_AFTER_MS: u64 = 7_000;
const DONE_FEATURE_MS: u64 = 7_000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClaudeStatus {
    Running,
    Done,
    Error,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClaudeRow {
    pub label: String,
    pub seconds: Option<f64>,
    pub kind: String,
    pub active: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClaudeActivity {
    pub session_id: String,
    pub cwd: String,
    pub transcript: std::path::PathBuf,
    pub title: String,
    pub title_meta: Option<String>,
    pub model: Option<String>,
    pub steps_done: u32,
    pub steps_total: u32,
    pub started_at: u64,
    pub updated_at: u64,
    pub status: ClaudeStatus,
    pub action: String,
    pub rows: Vec<ClaudeRow>,
    pub done_summary: Option<String>,
    pub files_changed: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ClaudeEvent {
    Unchanged,
    Activity(ClaudeActivity),
    Cleared,
}

pub struct ClaudeWatcher {
    sessions: HashMap<String, SessionState>,
    muted: HashMap<String, u64>,
    desktop: HashMap<String, Option<DesktopMeta>>,
    last_emitted: Option<ClaudeActivity>,
}

impl ClaudeWatcher {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            muted: HashMap::new(),
            desktop: HashMap::new(),
            last_emitted: None,
        }
    }

    /// Cheap poll; call every ~500ms from one task.
    pub fn poll(&mut self) -> ClaudeEvent {
        self.poll_at(now_ms())
    }

    /// Stop showing this session until it starts a new user turn.
    pub fn dismiss(&mut self, session_id: &str) {
        self.muted.insert(session_id.to_string(), now_ms());
    }

    /// Folder or transcript to open for "Open run".
    pub fn open_target(&self, session_id: &str) -> Option<std::path::PathBuf> {
        let state = self.sessions.get(session_id)?;
        if !state.cwd.is_empty() {
            return Some(PathBuf::from(&state.cwd));
        }
        state.transcript.clone()
    }

    fn poll_at(&mut self, now: u64) -> ClaudeEvent {
        if let Some(root) = claude_root() {
            for entry in read_registry(&root) {
                self.consider_entry(&root, entry, now);
            }
        }
        let mut unmute = Vec::new();
        for (id, state) in self.sessions.iter_mut() {
            state.tail(now);
            state.finalize(now);
            if let Some(at) = state.unmute_requested.take() {
                if self.muted.get(id).is_none_or(|dismissed| at > *dismissed) {
                    unmute.push(id.clone());
                }
            }
        }
        for id in unmute {
            self.muted.remove(&id);
        }
        self.sessions
            .retain(|_, state| now.saturating_sub(state.last_activity()) < INACTIVE_WINDOW_MS);
        let chosen = self
            .sessions
            .iter()
            .filter(|(id, state)| {
                !self.muted.contains_key(*id)
                    && !state.cleared
                    && state.run.started
                    && match state.status {
                        ClaudeStatus::Running => true,
                        ClaudeStatus::Error => {
                            now.saturating_sub(state.updated_at) <= DONE_FEATURE_MS
                        }
                        ClaudeStatus::Done => state
                            .done_at
                            .is_some_and(|at| now.saturating_sub(at) <= DONE_FEATURE_MS),
                    }
            })
            .max_by_key(|(id, state)| {
                let priority = match state.status {
                    ClaudeStatus::Running => 2,
                    ClaudeStatus::Error => 1,
                    ClaudeStatus::Done => 0,
                };
                (priority, state.updated_at, (*id).clone())
            })
            .map(|(_, state)| state);
        let Some(state) = chosen else {
            if self.last_emitted.is_some() {
                self.last_emitted = None;
                return ClaudeEvent::Cleared;
            }
            return ClaudeEvent::Unchanged;
        };
        let Some(activity) = state.activity(now) else {
            if self.last_emitted.is_some() {
                self.last_emitted = None;
                return ClaudeEvent::Cleared;
            }
            return ClaudeEvent::Unchanged;
        };
        if self.last_emitted.as_ref() == Some(&activity) {
            return ClaudeEvent::Unchanged;
        }
        self.last_emitted = Some(activity.clone());
        ClaudeEvent::Activity(activity)
    }

    fn consider_entry(&mut self, root: &Path, entry: RegistryEntry, now: u64) {
        let needs_meta =
            entry.cwd.is_none() || entry.session_id.as_deref().is_none_or(str::is_empty);
        let meta = if needs_meta {
            entry.host_session_id.as_deref().map(|host| {
                self.desktop
                    .entry(host.to_string())
                    .or_insert_with(|| desktop_meta_for(host))
                    .clone()
            })
        } else {
            None
        }
        .flatten();
        let Some(session_id) = entry
            .session_id
            .clone()
            .or_else(|| meta.as_ref().and_then(|m| m.cli_session_id.clone()))
        else {
            return;
        };
        if session_id.is_empty() {
            return;
        }
        let cwd = entry
            .cwd
            .clone()
            .or_else(|| meta.as_ref().and_then(|m| m.cwd.clone()))
            .unwrap_or_default();
        let existing = self.sessions.get(&session_id);
        let transcript = match existing.and_then(|state| state.transcript.clone()) {
            Some(path) if path.is_file() => Some(path),
            _ => resolve_transcript(root, &cwd, &session_id),
        };
        let transcript_mtime = transcript.as_deref().and_then(mtime_ms).unwrap_or(0);
        let updated_at = entry.updated_at;
        if transcript_mtime.max(updated_at) < now.saturating_sub(ACTIVE_WINDOW_MS) {
            return;
        }
        if let Some(state) = self.sessions.get_mut(&session_id) {
            if state.cwd.is_empty() && !cwd.is_empty() {
                state.cwd = cwd;
            }
            let current_ok = state.transcript.as_ref().is_some_and(|path| path.is_file());
            if !current_ok && transcript.is_some() {
                state.transcript = transcript;
            }
            state.registry_updated_at = state.registry_updated_at.max(updated_at);
            state.last_discovered = now;
        } else {
            let mut state = SessionState::new(session_id.clone(), cwd, transcript, now);
            state.registry_updated_at = updated_at;
            state.updated_at = updated_at;
            self.sessions.insert(session_id, state);
        }
    }
}

impl Default for ClaudeWatcher {
    fn default() -> Self {
        Self::new()
    }
}

struct RegistryEntry {
    session_id: Option<String>,
    cwd: Option<String>,
    host_session_id: Option<String>,
    updated_at: u64,
}

#[derive(Clone)]
struct DesktopMeta {
    cli_session_id: Option<String>,
    cwd: Option<String>,
}

struct SessionState {
    session_id: String,
    cwd: String,
    transcript: Option<PathBuf>,
    offset: u64,
    seeded: bool,
    leftover: Vec<u8>,
    skipping: bool,
    run: RunState,
    model_raw: Option<String>,
    updated_at: u64,
    last_record_at: u64,
    registry_updated_at: u64,
    last_discovered: u64,
    status: ClaudeStatus,
    done_at: Option<u64>,
    cleared: bool,
    unmute_requested: Option<u64>,
}

impl SessionState {
    fn new(session_id: String, cwd: String, transcript: Option<PathBuf>, now: u64) -> Self {
        Self {
            session_id,
            cwd,
            transcript,
            offset: 0,
            seeded: false,
            leftover: Vec::new(),
            skipping: false,
            run: RunState::default(),
            model_raw: None,
            updated_at: now,
            last_record_at: now,
            registry_updated_at: 0,
            last_discovered: now,
            status: ClaudeStatus::Running,
            done_at: None,
            cleared: false,
            unmute_requested: None,
        }
    }

    fn last_activity(&self) -> u64 {
        self.last_record_at
            .max(self.registry_updated_at)
            .max(self.last_discovered)
    }

    fn tail(&mut self, now: u64) {
        let Some(path) = self.transcript.clone() else {
            return;
        };
        let Ok(meta) = fs::metadata(&path) else {
            return;
        };
        let len = meta.len();
        if !self.seeded {
            let start = len.saturating_sub(TAIL_BYTES);
            let mut buf = Vec::new();
            if let Ok(mut file) = File::open(&path) {
                if file.seek(SeekFrom::Start(start)).is_ok() {
                    let _ = file.take(TAIL_BYTES).read_to_end(&mut buf);
                }
            }
            self.offset = start + buf.len() as u64;
            self.seeded = true;
            self.feed(&buf, start > 0, now);
            return;
        }
        if len < self.offset {
            self.offset = 0;
            self.leftover.clear();
            self.skipping = false;
            self.seeded = false;
            self.tail(now);
            return;
        }
        if len == self.offset {
            return;
        }
        let want = (len - self.offset).min(MAX_READ);
        let mut buf = Vec::with_capacity(want as usize);
        if let Ok(mut file) = File::open(&path) {
            if file.seek(SeekFrom::Start(self.offset)).is_ok() {
                let _ = file.take(want).read_to_end(&mut buf);
            }
        }
        self.offset += buf.len() as u64;
        self.feed(&buf, false, now);
    }

    fn feed(&mut self, bytes: &[u8], drop_partial: bool, now: u64) {
        let mut data = bytes;
        if drop_partial {
            match data.iter().position(|byte| *byte == b'\n') {
                Some(pos) => data = &data[pos + 1..],
                None => {
                    self.skipping = true;
                    return;
                }
            }
        }
        let mut start = 0;
        for index in 0..data.len() {
            if data[index] != b'\n' {
                continue;
            }
            if self.skipping {
                self.skipping = false;
                self.leftover.clear();
            } else {
                let segment = &data[start..index];
                if self.leftover.len() + segment.len() > MAX_LINE {
                    self.leftover.clear();
                } else {
                    self.leftover.extend_from_slice(segment);
                    if self.leftover.last() == Some(&b'\r') {
                        self.leftover.pop();
                    }
                    let line = std::mem::take(&mut self.leftover);
                    if !line.is_empty() {
                        self.observe_line(&line, now);
                    }
                }
            }
            start = index + 1;
        }
        if start < data.len() && !self.skipping {
            let rest = &data[start..];
            if self.leftover.len() + rest.len() > MAX_LINE {
                self.leftover.clear();
                self.skipping = true;
            } else {
                self.leftover.extend_from_slice(rest);
            }
        }
    }

    fn observe_line(&mut self, line: &[u8], now: u64) {
        let text = String::from_utf8_lossy(line);
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            return;
        };
        if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return;
        }
        let timestamp = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339)
            .unwrap_or(now);
        match value.get("type").and_then(Value::as_str).unwrap_or("") {
            "user" => self.on_user(&value, timestamp),
            "assistant" => self.on_assistant(&value, timestamp),
            _ => {}
        }
    }

    fn on_user(&mut self, value: &Value, timestamp: u64) {
        let content = value.pointer("/message/content");
        let blocks = content.and_then(Value::as_array);
        let has_result = blocks.is_some_and(|blocks| {
            blocks
                .iter()
                .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        });
        if has_result {
            if !self.run.started {
                self.start_run(timestamp);
            }
            self.touch(timestamp);
            self.run.last_was_error = false;
            if let Some(blocks) = blocks {
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
                        continue;
                    };
                    let is_error = block
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    self.complete_tool(id, timestamp, is_error);
                    self.run.last_was_error = is_error;
                }
            }
            return;
        }
        if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
            return;
        }
        let origin_human = value
            .pointer("/origin/kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "human");
        let text = match content {
            Some(Value::String(text)) => Some(text.as_str()),
            Some(Value::Array(blocks)) => blocks.iter().find_map(|block| {
                (block.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| block.get("text").and_then(Value::as_str))
                    .flatten()
            }),
            _ => None,
        };
        let is_human_turn = origin_human
            || match content {
                Some(Value::String(_)) => true,
                Some(Value::Array(_)) => text.is_some(),
                _ => false,
            };
        if !is_human_turn {
            return;
        }
        let lead = text.unwrap_or("").trim_start();
        if lead.starts_with("<command-name>") || lead.starts_with("<local-command") {
            return;
        }
        self.start_run(timestamp);
        self.touch(timestamp);
        self.unmute_requested = Some(timestamp);
    }

    fn on_assistant(&mut self, value: &Value, timestamp: u64) {
        if !self.run.started {
            self.start_run(timestamp);
        }
        self.touch(timestamp);
        self.run.last_was_error = false;
        if let Some(model) = value.pointer("/message/model").and_then(Value::as_str) {
            self.model_raw = Some(model.to_string());
        }
        self.run.last_stop = value
            .pointer("/message/stop_reason")
            .and_then(Value::as_str)
            .map(str::to_string);
        let content = value.pointer("/message/content");
        if let Some(blocks) = content.and_then(Value::as_array) {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                    continue;
                }
                let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                let id = block.get("id").and_then(Value::as_str);
                let input = block.get("input").cloned().unwrap_or(Value::Null);
                self.push_tool(name, &input, id, timestamp);
            }
        }
    }

    fn start_run(&mut self, timestamp: u64) {
        self.run = RunState::new(timestamp);
        self.status = ClaudeStatus::Running;
        self.done_at = None;
        self.cleared = false;
    }

    fn touch(&mut self, timestamp: u64) {
        self.run.updated_at = timestamp;
        self.updated_at = timestamp;
        self.last_record_at = timestamp;
        if self.status != ClaudeStatus::Running || self.cleared {
            self.status = ClaudeStatus::Running;
            self.done_at = None;
            self.cleared = false;
        }
    }

    fn push_tool(&mut self, name: &str, input: &Value, id: Option<&str>, timestamp: u64) {
        let (kind, title, label) = describe_tool(name, input);
        if matches!(kind.as_str(), "edit" | "write") {
            if let Some(path) = input
                .get("file_path")
                .or_else(|| input.get("notebook_path"))
                .and_then(Value::as_str)
            {
                self.run.files.insert(path.to_string());
            }
        }
        if matches!(name, "TodoWrite" | "mcp__ccd_turn__update_plan") {
            apply_plan(&mut self.run, name, input);
        }
        let row = RowState {
            id: id.map(str::to_string),
            label,
            kind,
            title,
            seconds: None,
            call_ms: timestamp,
            completed: false,
        };
        self.run.rows.push(row);
        if self.run.rows.len() > MAX_ROWS {
            self.run.rows.remove(0);
        }
    }

    fn complete_tool(&mut self, id: &str, timestamp: u64, is_error: bool) {
        let Some(row) = self
            .run
            .rows
            .iter_mut()
            .rev()
            .find(|row| !row.completed && row.id.as_deref() == Some(id))
        else {
            return;
        };
        row.completed = true;
        row.seconds = Some(if timestamp >= row.call_ms {
            (timestamp - row.call_ms) as f64 / 1000.0
        } else {
            0.0
        });
        if is_error {
            row.kind = "terminal".to_string();
        }
        self.run.completed_calls = self.run.completed_calls.saturating_add(1).min(999);
    }

    fn finalize(&mut self, now: u64) {
        if !self.run.started || self.cleared {
            return;
        }
        if self.run.last_was_error {
            self.status = ClaudeStatus::Error;
            return;
        }
        if self.status == ClaudeStatus::Error {
            self.status = ClaudeStatus::Running;
            self.done_at = None;
        }
        if self.status == ClaudeStatus::Done {
            if self
                .done_at
                .is_some_and(|at| now.saturating_sub(at) >= CLEAR_AFTER_MS)
            {
                self.cleared = true;
            }
            return;
        }
        let quiet = now.saturating_sub(self.last_record_at);
        let no_open = !self.run.rows.iter().any(|row| !row.completed);
        let ended = self.run.last_stop.as_deref() == Some("end_turn");
        if (ended && no_open && quiet >= DONE_QUIET_MS) || quiet >= DONE_SILENCE_MS {
            self.status = ClaudeStatus::Done;
            self.done_at = Some(now);
        }
    }

    fn activity(&self, _now: u64) -> Option<ClaudeActivity> {
        if !self.run.started || self.cleared {
            return None;
        }
        let (action, action_title) = self.current_action();
        let active_index = self.run.rows.iter().rposition(|row| !row.completed);
        let start = self.run.rows.len().saturating_sub(5);
        let rows = self
            .run
            .rows
            .iter()
            .enumerate()
            .skip(start)
            .map(|(index, row)| ClaudeRow {
                label: row.label.clone(),
                seconds: row.seconds,
                kind: row.kind.clone(),
                active: Some(index) == active_index,
            })
            .collect();
        let files_changed = self.run.files.len().min(u32::MAX as usize) as u32;
        let done = self.status == ClaudeStatus::Done;
        let title = if done {
            format!(
                "Done in {}",
                fmt_elapsed(self.updated_at.saturating_sub(self.run.started_at))
            )
        } else {
            action_title
        };
        let title_meta = if done && files_changed > 0 {
            Some(format!("· {}", files_phrase(files_changed)))
        } else {
            None
        };
        let (steps_total, steps_done) = if self.run.plan_total > 0 {
            (self.run.plan_total, self.run.plan_done)
        } else {
            (0, self.run.completed_calls)
        };
        Some(ClaudeActivity {
            session_id: self.session_id.clone(),
            cwd: self.cwd.clone(),
            transcript: self.transcript.clone().unwrap_or_default(),
            title,
            title_meta,
            model: self.model_raw.as_deref().map(model_display),
            steps_done,
            steps_total,
            started_at: self.run.started_at,
            updated_at: self.updated_at,
            status: self.status,
            action,
            rows,
            done_summary: if done {
                Some(files_phrase(files_changed))
            } else {
                None
            },
            files_changed,
        })
    }

    fn current_action(&self) -> (String, String) {
        if let Some(row) = self.run.rows.iter().rev().find(|row| !row.completed) {
            return (row.kind.clone(), row.title.clone());
        }
        if let Some(row) = self.run.rows.last() {
            return (row.kind.clone(), row.title.clone());
        }
        ("think".to_string(), "Thinking".to_string())
    }
}

#[derive(Default)]
struct RunState {
    started: bool,
    started_at: u64,
    updated_at: u64,
    rows: Vec<RowState>,
    files: HashSet<String>,
    plan_total: u32,
    plan_done: u32,
    completed_calls: u32,
    last_stop: Option<String>,
    last_was_error: bool,
}

impl RunState {
    fn new(timestamp: u64) -> Self {
        Self {
            started: true,
            started_at: timestamp,
            updated_at: timestamp,
            ..Self::default()
        }
    }
}

struct RowState {
    id: Option<String>,
    label: String,
    kind: String,
    title: String,
    seconds: Option<f64>,
    call_ms: u64,
    completed: bool,
}

fn apply_plan(run: &mut RunState, name: &str, input: &Value) {
    let items = if name == "TodoWrite" {
        input.get("todos").and_then(Value::as_array)
    } else {
        input
            .get("items")
            .or_else(|| input.get("plan"))
            .or_else(|| input.get("steps"))
            .and_then(Value::as_array)
    };
    let Some(items) = items else {
        return;
    };
    run.plan_total = items.len().min(u32::MAX as usize) as u32;
    run.plan_done = items
        .iter()
        .filter(|item| item.get("status").and_then(Value::as_str) == Some("completed"))
        .count()
        .min(u32::MAX as usize) as u32;
}

fn describe_tool(name: &str, input: &Value) -> (String, String, String) {
    let string = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("");
    match name {
        "Read" => {
            let file = basename(string("file_path"));
            (
                "read".to_string(),
                format!("Reading {file}"),
                format!("Read {file}"),
            )
        }
        "Glob" | "Grep" | "WebSearch" => {
            let what = if name == "Glob" {
                string("pattern")
            } else if name == "Grep" {
                string("pattern")
            } else {
                string("query")
            };
            let what = if what.is_empty() { name } else { what };
            (
                "search".to_string(),
                format!("Searching for {what}"),
                format!("Searched for {what}"),
            )
        }
        "Edit" | "MultiEdit" | "NotebookEdit" => {
            let path = if string("file_path").is_empty() {
                string("notebook_path")
            } else {
                string("file_path")
            };
            let file = basename(path);
            (
                "edit".to_string(),
                format!("Editing {file}"),
                format!("Edited {file}"),
            )
        }
        "Write" => {
            let file = basename(string("file_path"));
            (
                "write".to_string(),
                format!("Writing {file}"),
                format!("Wrote {file}"),
            )
        }
        "Bash" | "PowerShell" => {
            let command = string("command");
            let description = string("description");
            let haystack = format!("{description} {command}").to_lowercase();
            let kind = if haystack.contains("test") {
                "test"
            } else {
                "bash"
            };
            let title = if !description.is_empty() {
                format!("Running {description}")
            } else {
                let first = command.lines().next().unwrap_or("").trim();
                format!("Running {}", truncate(first, 40))
            };
            let shown = if !description.is_empty() {
                description
            } else {
                command.lines().next().unwrap_or("").trim()
            };
            (
                kind.to_string(),
                title,
                format!("Ran {}", truncate(shown, 60)),
            )
        }
        "Task" => (
            "task".to_string(),
            "Running a subagent".to_string(),
            "Ran a subagent".to_string(),
        ),
        "TodoWrite" | "mcp__ccd_turn__update_plan" => (
            "todo".to_string(),
            "Updating the plan".to_string(),
            "Updated the plan".to_string(),
        ),
        other => ("terminal".to_string(), other.to_string(), other.to_string()),
    }
}

fn basename(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    let name = trimmed
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(trimmed)
        .to_string();
    if name.is_empty() {
        "file".to_string()
    } else {
        name
    }
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect()
}

fn files_phrase(count: u32) -> String {
    format!("{count} file{} changed", if count == 1 { "" } else { "s" })
}

fn fmt_elapsed(ms: u64) -> String {
    let seconds = ms as f64 / 1000.0;
    if seconds < 10.0 {
        format!("{seconds:.1}s")
    } else {
        format!("{}s", seconds.round() as u64)
    }
}

fn model_display(raw: &str) -> String {
    let stripped = raw.strip_prefix("anthropic.").unwrap_or(raw);
    let stripped = stripped.strip_prefix("claude-").unwrap_or(stripped);
    let parts: Vec<&str> = stripped.split('-').collect();
    if parts.len() >= 2 && is_family(parts[1]) {
        return format!("Claude {} {}", parts[0], family_name(parts[1]));
    }
    if parts.len() >= 3 && parts[0].chars().all(|ch| ch.is_ascii_digit()) && is_family(parts[2]) {
        return format!("Claude {}.{} {}", parts[0], parts[1], family_name(parts[2]));
    }
    if parts.len() >= 2 && is_family(parts[0]) {
        let manual_minor = parts
            .get(2)
            .is_some_and(|part| part.len() <= 2 && part.chars().all(|ch| ch.is_ascii_digit()));
        if manual_minor {
            return format!("Claude {} {}.{}", family_name(parts[0]), parts[1], parts[2]);
        }
        return format!("Claude {} {}", family_name(parts[0]), parts[1]);
    }
    raw.to_string()
}

fn is_family(value: &str) -> bool {
    matches!(value, "sonnet" | "opus" | "haiku")
}

fn family_name(value: &str) -> String {
    match value {
        "sonnet" => "Sonnet".to_string(),
        "opus" => "Opus".to_string(),
        "haiku" => "Haiku".to_string(),
        other => {
            let mut chars = other.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn mtime_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn claude_root() -> Option<PathBuf> {
    for variable in ["USERPROFILE", "HOME"] {
        let Some(home) = env::var_os(variable) else {
            continue;
        };
        let root = PathBuf::from(home).join(".claude");
        if root.is_dir() {
            return Some(root);
        }
    }
    None
}

fn read_registry(root: &Path) -> Vec<RegistryEntry> {
    let mut entries = Vec::new();
    let Ok(dir) = fs::read_dir(root.join("sessions")) else {
        return entries;
    };
    for item in dir.flatten() {
        let path = item.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(entrypoint) = value.get("entrypoint").and_then(Value::as_str) {
            if entrypoint != "cli" && entrypoint != "claude-desktop" {
                continue;
            }
        }
        let file_mtime = mtime_ms(&path).unwrap_or(0);
        entries.push(RegistryEntry {
            session_id: value
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
            cwd: value.get("cwd").and_then(Value::as_str).map(str::to_string),
            host_session_id: value
                .get("hostSessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
            updated_at: value
                .get("updatedAt")
                .and_then(Value::as_u64)
                .unwrap_or(file_mtime),
        });
    }
    entries
}

fn desktop_meta_for(host: &str) -> Option<DesktopMeta> {
    let base = PathBuf::from(env::var_os("APPDATA")?)
        .join("Claude")
        .join("claude-code-sessions");
    let file_name = if host.starts_with("local_") {
        format!("{host}.json")
    } else {
        format!("local_{host}.json")
    };
    let direct = base.join(&file_name);
    if let Ok(text) = fs::read_to_string(&direct) {
        return parse_desktop(&text);
    }
    let Ok(accounts) = fs::read_dir(&base) else {
        return None;
    };
    for account in accounts.flatten() {
        if !account.path().is_dir() {
            continue;
        }
        let Ok(workspaces) = fs::read_dir(account.path()) else {
            continue;
        };
        for workspace in workspaces.flatten() {
            if !workspace.path().is_dir() {
                continue;
            }
            let candidate = workspace.path().join(&file_name);
            if let Ok(text) = fs::read_to_string(candidate) {
                return parse_desktop(&text);
            }
        }
    }
    None
}

fn parse_desktop(text: &str) -> Option<DesktopMeta> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    Some(DesktopMeta {
        cli_session_id: value
            .get("cliSessionId")
            .and_then(Value::as_str)
            .map(str::to_string),
        cwd: value.get("cwd").and_then(Value::as_str).map(str::to_string),
    })
}

fn resolve_transcript(root: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    let projects = root.join("projects");
    if !cwd.is_empty() {
        let dir = projects.join(slugify(cwd));
        let exact = dir.join(format!("{session_id}.jsonl"));
        if exact.is_file() {
            return Some(exact);
        }
        let mut matched = None;
        let mut newest: Option<(u64, PathBuf)> = None;
        if let Ok(items) = fs::read_dir(&dir) {
            for item in items.flatten() {
                let path = item.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                    continue;
                }
                if path.file_stem().and_then(|stem| stem.to_str()) == Some(session_id) {
                    matched = Some(path);
                    continue;
                }
                let modified = mtime_ms(&path).unwrap_or(0);
                if newest.as_ref().is_none_or(|(at, _)| modified > *at) {
                    newest = Some((modified, path));
                }
            }
        }
        if let Some(path) = matched {
            return Some(path);
        }
        if let Some((_, path)) = newest {
            return Some(path);
        }
    }
    if let Ok(dirs) = fs::read_dir(&projects) {
        for dir in dirs.flatten() {
            if !dir.path().is_dir() {
                continue;
            }
            let candidate = dir.path().join(format!("{session_id}.jsonl"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn slugify(cwd: &str) -> String {
    cwd.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn parse_rfc3339(text: &str) -> Option<u64> {
    let text = text.trim();
    let bytes = text.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' && bytes[10] != b't' {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let year = number(&bytes[0..4])? as i64;
    let month = number(&bytes[5..7])? as i64;
    let day = number(&bytes[8..10])? as i64;
    let hour = number(&bytes[11..13])? as i64;
    let minute = number(&bytes[14..16])? as i64;
    let second = number(&bytes[17..19])? as i64;
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut index = 19;
    let mut millis = 0_i64;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return None;
        }
        let digits = &text[start..index];
        let take = digits.len().min(3);
        let mut value = digits[..take].parse::<i64>().ok()?;
        for _ in take..3 {
            value *= 10;
        }
        millis = value;
    }
    let offset = match bytes.get(index) {
        Some(b'Z') | Some(b'z') => {
            index += 1;
            0_i64
        }
        Some(&sign @ (b'+' | b'-')) => {
            index += 1;
            let offset_hour = number(bytes.get(index..index + 2)?)? as i64;
            index += 2;
            if bytes.get(index) == Some(&b':') {
                index += 1;
            }
            let offset_minute = number(bytes.get(index..index + 2)?)? as i64;
            index += 2;
            if offset_hour > 23 || offset_minute > 59 {
                return None;
            }
            let total = offset_hour * 3600 + offset_minute * 60;
            if sign == b'-' { -total } else { total }
        }
        Some(_) => return None,
        None => 0,
    };
    if index != bytes.len() {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset;
    let ms = seconds * 1000 + millis;
    if ms < 0 { None } else { Some(ms as u64) }
}

fn number(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let mut value = 0_u32;
    for byte in bytes {
        value = value.checked_mul(10)?.checked_add((byte - b'0') as u32)?;
    }
    Some(value)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - if month <= 2 { 1 } else { 0 };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted_month = (month + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_state() -> SessionState {
        SessionState {
            session_id: "session-1".to_string(),
            cwd: "C:\\work".to_string(),
            transcript: Some(PathBuf::from("session-1.jsonl")),
            offset: 0,
            seeded: true,
            leftover: Vec::new(),
            skipping: false,
            run: RunState::default(),
            model_raw: None,
            updated_at: 0,
            last_record_at: 0,
            registry_updated_at: 0,
            last_discovered: 0,
            status: ClaudeStatus::Running,
            done_at: None,
            cleared: false,
            unmute_requested: None,
        }
    }

    fn ingest(state: &mut SessionState, value: Value, now: u64) {
        let line = value.to_string();
        state.observe_line(line.as_bytes(), now);
    }

    #[test]
    fn parses_rfc3339() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339("2026-10-24T12:34:56.789Z"),
            Some(1_792_845_296_789)
        );
        assert_eq!(
            parse_rfc3339("2026-10-24T14:34:56+02:00"),
            Some(1_792_845_296_000)
        );
        assert_eq!(
            parse_rfc3339("2026-10-24T12:34:56.7Z"),
            Some(1_792_845_296_700)
        );
        assert!(parse_rfc3339("garbage").is_none());
        assert!(parse_rfc3339("2026-13-24T12:34:56Z").is_none());
    }

    #[test]
    fn maps_model_names() {
        assert_eq!(
            model_display("claude-sonnet-4-5-20250929"),
            "Claude Sonnet 4.5"
        );
        assert_eq!(
            model_display("claude-3-5-sonnet-20241022"),
            "Claude 3.5 Sonnet"
        );
        assert_eq!(model_display("claude-opus-4-1-20250805"), "Claude Opus 4.1");
        assert_eq!(
            model_display("claude-haiku-4-5-20251001"),
            "Claude Haiku 4.5"
        );
        assert_eq!(model_display("claude-sonnet-5-5"), "Claude Sonnet 5.5");
        assert_eq!(model_display("made-up-model"), "made-up-model");
    }

    #[test]
    fn reads_a_synthetic_run_to_done() {
        let mut state = test_state();
        let base = parse_rfc3339("2026-10-24T12:00:00.000Z").unwrap();
        ingest(
            &mut state,
            json!({                "type": "user",                "message": {"role": "user", "content": "ship it"},                "timestamp": "2026-10-24T12:00:00.000Z"            }),
            base,
        );
        ingest(
            &mut state,
            json!({                "type": "assistant",                "message": {                    "role": "assistant",                    "model": "claude-sonnet-4-5-20250929",                    "content": [{                        "type": "tool_use",                        "id": "tool-1",                        "name": "Bash",                        "input": {"command": "cargo test", "description": "Run tests"}                    }],                    "stop_reason": "tool_use"                },                "timestamp": "2026-10-24T12:00:01.000Z"            }),
            base + 1000,
        );
        ingest(
            &mut state,
            json!({                "type": "user",                "message": {                    "role": "user",                    "content": [{                        "type": "tool_result",                        "tool_use_id": "tool-1",                        "is_error": false,                        "content": "ok"                    }]                },                "timestamp": "2026-10-24T12:00:03.500Z"            }),
            base + 3500,
        );
        ingest(
            &mut state,
            json!({                "type": "assistant",                "message": {                    "role": "assistant",                    "model": "claude-sonnet-4-5-20250929",                    "content": [{                        "type": "tool_use",                        "id": "tool-2",                        "name": "Edit",                        "input": {"file_path": "C:\\work\\src\\foo.rs"}                    }],                    "stop_reason": "tool_use"                },                "timestamp": "2026-10-24T12:00:04.000Z"            }),
            base + 4000,
        );
        ingest(
            &mut state,
            json!({                "type": "user",                "message": {                    "role": "user",                    "content": [{                        "type": "tool_result",                        "tool_use_id": "tool-2",                        "is_error": false,                        "content": "done"                    }]                },                "timestamp": "2026-10-24T12:00:05.000Z"            }),
            base + 5000,
        );
        ingest(
            &mut state,
            json!({                "type": "assistant",                "message": {                    "role": "assistant",                    "content": [{                        "type": "tool_use",                        "id": "tool-3",                        "name": "TodoWrite",                        "input": {"todos": [                            {"content": "one", "status": "completed"},                            {"content": "two", "status": "in_progress"}                        ]}                    }],                    "stop_reason": "tool_use"                },                "timestamp": "2026-10-24T12:00:06.000Z"            }),
            base + 6000,
        );
        ingest(
            &mut state,
            json!({                "type": "user",                "message": {                    "role": "user",                    "content": [{                        "type": "tool_result",                        "tool_use_id": "tool-3",                        "is_error": false,                        "content": "updated"                    }]                },                "timestamp": "2026-10-24T12:00:06.500Z"            }),
            base + 6500,
        );
        ingest(
            &mut state,
            json!({                "type": "assistant",                "message": {                    "role": "assistant",                    "content": [{"type": "text", "text": "All done."}],                    "stop_reason": "end_turn"                },                "timestamp": "2026-10-24T12:00:08.000Z"            }),
            base + 8000,
        );
        state.finalize(base + 9300);
        let activity = state.activity(base + 9300).unwrap();
        assert_eq!(activity.status, ClaudeStatus::Done);
        assert_eq!(activity.title, "Done in 8.0s");
        assert_eq!(activity.title_meta.as_deref(), Some("· 1 file changed"));
        assert_eq!(activity.done_summary.as_deref(), Some("1 file changed"));
        assert_eq!(activity.action, "todo");
        assert_eq!(activity.steps_total, 2);
        assert_eq!(activity.steps_done, 1);
        assert_eq!(activity.files_changed, 1);
        assert_eq!(activity.model.as_deref(), Some("Claude Sonnet 4.5"));
        assert_eq!(activity.rows.len(), 3);
        assert_eq!(activity.rows[0].label, "Ran Run tests");
        assert_eq!(activity.rows[0].kind, "test");
        assert_eq!(activity.rows[0].seconds, Some(2.5));
        assert_eq!(activity.rows[1].kind, "edit");
        assert_eq!(activity.rows[1].label, "Edited foo.rs");
        assert!(!activity.rows.iter().any(|row| row.active));
        state.finalize(base + 17_000);
        assert!(state.activity(base + 17_000).is_none());
    }

    #[test]
    fn handles_plan_items_and_error_results() {
        let mut state = test_state();
        let base = parse_rfc3339("2026-10-24T13:00:00.000Z").unwrap();

        ingest(
            &mut state,
            json!({
                "type": "user",
                "message": {"role": "user", "content": "go"},
                "timestamp": "2026-10-24T13:00:00.000Z"
            }),
            base,
        );
        ingest(
            &mut state,
            json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "plan-1",
                        "name": "mcp__ccd_turn__update_plan",
                        "input": {"items": [
                            {"content": "a", "status": "completed"},
                            {"content": "b", "status": "pending"},
                            {"content": "c", "status": "completed"}
                        ]}
                    }],
                    "stop_reason": "tool_use"
                },
                "timestamp": "2026-10-24T13:00:01.000Z"
            }),
            base + 1000,
        );
        ingest(
            &mut state,
            json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "plan-1",
                        "is_error": false,
                        "content": "ok"
                    }]
                },
                "timestamp": "2026-10-24T13:00:02.000Z"
            }),
            base + 2000,
        );
        ingest(
            &mut state,
            json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "bash-1",
                        "name": "Bash",
                        "input": {"command": "false", "description": "Failing check"}
                    }],
                    "stop_reason": "tool_use"
                },
                "timestamp": "2026-10-24T13:00:03.000Z"
            }),
            base + 3000,
        );
        ingest(
            &mut state,
            json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "bash-1",
                        "is_error": true,
                        "content": "failed"
                    }]
                },
                "timestamp": "2026-10-24T13:00:04.000Z"
            }),
            base + 4000,
        );

        state.finalize(base + 4100);
        let activity = state.activity(base + 4100).unwrap();
        assert_eq!(activity.status, ClaudeStatus::Error);
        assert_eq!(activity.steps_total, 3);
        assert_eq!(activity.steps_done, 2);
        assert_eq!(activity.action, "terminal");
        assert_eq!(activity.rows.last().unwrap().kind, "terminal");
        assert_eq!(activity.rows.last().unwrap().label, "Ran Failing check");

        ingest(
            &mut state,
            json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "retrying"}],
                    "stop_reason": "end_turn"
                },
                "timestamp": "2026-10-24T13:00:05.000Z"
            }),
            base + 5000,
        );
        state.finalize(base + 5100);
        assert_eq!(state.status, ClaudeStatus::Running);
    }

    #[test]
    fn keeps_partial_lines_between_chunks() {
        let mut state = test_state();
        let base = parse_rfc3339("2026-10-24T12:00:00.000Z").unwrap();
        let line = json!({            "type": "user",            "message": {"role": "user", "content": "hello"},            "timestamp": "2026-10-24T12:00:00.000Z"        })        .to_string();
        let split = line.len() / 2;
        state.feed(&line.as_bytes()[..split], false, base);
        assert!(!state.run.started);
        state.feed(&line.as_bytes()[split..], false, base);
        state.feed(b"\n", false, base);
        assert!(state.run.started);
        assert_eq!(state.run.started_at, base);
        assert_eq!(state.current_action().1, "Thinking");
        let second = json!({            "type": "assistant",            "message": {                "role": "assistant",                "content": [{"type": "text", "text": "hi"}],                "stop_reason": "end_turn"            },            "timestamp": "2026-10-24T12:00:01.000Z"        })        .to_string();
        let cut = second.len() - 5;
        state.feed(&second.as_bytes()[..cut], false, base + 1000);
        state.feed(&second.as_bytes()[cut..], false, base + 1000);
        state.feed(b"\n", false, base + 1000);
        assert_eq!(state.run.last_stop.as_deref(), Some("end_turn"));
    }
}
