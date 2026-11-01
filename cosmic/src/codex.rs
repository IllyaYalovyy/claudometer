//! The Codex provider (RFC-002): a short-lived `codex app-server` is asked
//! the documented read-only `account/rateLimits/read` method. No thread,
//! turn, auth mutation, credit, or reset method is ever sent.
//!
//! Port of `src/lib/codex_snapshot.js`, `src/lib/codex_fetcher.js` and
//! `src/lib/codex_source.js`.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::claude::{ProviderError, resolve_cli_default};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    Primary,
    Secondary,
}

/// One Codex quota window inside a bucket (`limit_id`).
#[derive(Debug, Clone, PartialEq)]
pub struct CodexWindow {
    pub limit_id: String,
    pub limit_name: Option<String>,
    pub slot: Slot,
    pub percent: f64,
    pub duration_mins: Option<f64>,
    pub resets_at: Option<i64>,
    pub reached_type: Option<String>,
}

/// The authoritative `ordinaryUsageAllowed` field. `Absent` keeps
/// compatibility with older servers; an explicit `null` is `Unknown`, which
/// renders unavailable rather than guessing from percentages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Absent,
    Unknown,
    Allowed,
    Denied,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CodexSnapshot {
    pub fetched_at: i64,
    pub main_limit_id: Option<String>,
    pub access: Access,
    pub reset_credits_available: Option<u64>,
    pub windows: Vec<CodexWindow>,
    pub error: Option<ProviderError>,
    /// Journal-only detail for `ReadFailed`.
    pub reason: Option<&'static str>,
}

impl CodexSnapshot {
    pub fn failed(now: i64, error: ProviderError, reason: Option<&'static str>) -> Self {
        Self {
            fetched_at: now,
            main_limit_id: None,
            access: Access::Absent,
            reset_credits_available: None,
            windows: Vec::new(),
            error: Some(error),
            reason,
        }
    }

    pub fn is_error(&self) -> bool {
        self.error.is_some()
    }
}

struct Bucket {
    limit_id: String,
    limit_name: Option<String>,
    reached_type: Option<String>,
    windows: Vec<CodexWindow>,
}

fn optional_positive_number(value: Option<&Value>) -> Result<Option<f64>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(v) => match v.as_f64() {
            Some(n) if n.is_finite() && n > 0.0 => Ok(Some(n)),
            _ => Err(()),
        },
    }
}

fn optional_nonempty_string(value: Option<&Value>) -> Result<Option<String>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if !s.is_empty() => Ok(Some(s.clone())),
        Some(_) => Err(()),
    }
}

fn parse_window(value: &Value, bucket: &Bucket, slot: Slot) -> Option<CodexWindow> {
    let value = value.as_object()?;
    let used = value.get("usedPercent")?.as_f64()?;
    if !used.is_finite() {
        return None;
    }
    let duration_mins = optional_positive_number(value.get("windowDurationMins")).ok()?;
    let resets_at = optional_positive_number(value.get("resetsAt")).ok()?;
    Some(CodexWindow {
        limit_id: bucket.limit_id.clone(),
        limit_name: bucket.limit_name.clone(),
        slot,
        percent: used.clamp(0.0, 100.0),
        duration_mins,
        // App Server timestamps are Unix seconds; the display contract uses ms.
        resets_at: resets_at.map(|s| (s * 1000.0).round() as i64),
        reached_type: bucket.reached_type.clone(),
    })
}

fn parse_bucket(value: &Value, fallback_id: &str) -> Option<Bucket> {
    let value = value.as_object()?;
    let limit_id = match value.get("limitId") {
        None | Some(Value::Null) => fallback_id.to_owned(),
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        Some(_) => return None,
    };
    let limit_name = optional_nonempty_string(value.get("limitName")).ok()?;
    let reached_type = optional_nonempty_string(value.get("rateLimitReachedType")).ok()?;
    let mut bucket = Bucket {
        limit_id,
        limit_name,
        reached_type,
        windows: Vec::new(),
    };
    for (key, slot) in [("primary", Slot::Primary), ("secondary", Slot::Secondary)] {
        match value.get(key) {
            None | Some(Value::Null) => continue,
            Some(raw) => {
                let window = parse_window(raw, &bucket, slot)?;
                bucket.windows.push(window);
            }
        }
    }
    Some(bucket)
}

fn parse_access(result: &Map<String, Value>) -> Option<Access> {
    match result.get("ordinaryUsageAllowed") {
        None => Some(Access::Absent),
        Some(Value::Null) => Some(Access::Unknown),
        Some(Value::Bool(true)) => Some(Access::Allowed),
        Some(Value::Bool(false)) => Some(Access::Denied),
        Some(_) => None,
    }
}

fn parse_reset_credits(result: &Map<String, Value>) -> Option<Option<u64>> {
    match result.get("rateLimitResetCredits") {
        None | Some(Value::Null) => Some(None),
        Some(Value::Object(credits)) => credits
            .get("availableCount")
            .and_then(Value::as_u64)
            .map(Some),
        Some(_) => None,
    }
}

/// `result` is the value inside the matching JSON-RPC response. The
/// multi-bucket view wins when non-empty; `rateLimits` is only its
/// backward-compatible projection and displaying both would duplicate quota.
pub fn parse_codex_rate_limits(result: &Value, now: i64) -> CodexSnapshot {
    let unparseable = CodexSnapshot::failed(now, ProviderError::Unparseable, None);
    let Some(result) = result.as_object() else {
        return unparseable;
    };
    let (Some(access), Some(reset_credits)) = (parse_access(result), parse_reset_credits(result))
    else {
        return unparseable;
    };

    let entries: Vec<(String, &Value)> = match result.get("rateLimitsByLimitId") {
        Some(Value::Object(by_id)) if !by_id.is_empty() => {
            by_id.iter().map(|(k, v)| (k.clone(), v)).collect()
        }
        Some(Value::Object(_)) | None | Some(Value::Null) => match result.get("rateLimits") {
            None | Some(Value::Null) => {
                return CodexSnapshot::failed(now, ProviderError::NotAuthenticated, None);
            }
            // The protocol allows a null id on the legacy projection; it is
            // still the main Codex bucket by definition.
            Some(main) => vec![("codex".to_owned(), main)],
        },
        Some(_) => return unparseable,
    };

    let mut buckets = Vec::with_capacity(entries.len());
    for (fallback_id, raw) in entries {
        match parse_bucket(raw, &fallback_id) {
            Some(bucket) => buckets.push(bucket),
            None => return unparseable,
        }
    }

    // The backward-compatible projection identifies ordinary included usage.
    // Prefer its explicit id, then the documented `codex` id, then an
    // unlabelled bucket for older servers. Never let a named model bucket
    // become the provider-level meter merely because it arrived first.
    let explicit_main_id = match result.get("rateLimits") {
        None | Some(Value::Null) => None,
        Some(Value::Object(main)) => match main.get("limitId") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
            Some(_) => return unparseable,
        },
        Some(_) => return unparseable,
    };
    let main_limit_id = explicit_main_id
        .filter(|id| buckets.iter().any(|b| &b.limit_id == id))
        .or_else(|| {
            buckets
                .iter()
                .find(|b| b.limit_id == "codex")
                .or_else(|| buckets.iter().find(|b| b.limit_name.is_none()))
                .or_else(|| buckets.first())
                .map(|b| b.limit_id.clone())
        });
    let Some(main_limit_id) = main_limit_id else {
        return CodexSnapshot::failed(now, ProviderError::NotAuthenticated, None);
    };

    // Keep the main bucket first, then unlabelled compatibility buckets,
    // then named model buckets (stable, like the JS sort).
    buckets.sort_by_key(|bucket| {
        if bucket.limit_id == main_limit_id {
            0
        } else if bucket.limit_name.is_none() {
            1
        } else {
            2
        }
    });
    let windows: Vec<CodexWindow> = buckets.into_iter().flat_map(|b| b.windows).collect();
    if windows.is_empty() {
        return CodexSnapshot::failed(now, ProviderError::NotAuthenticated, None);
    }
    CodexSnapshot {
        fetched_at: now,
        main_limit_id: Some(main_limit_id),
        access,
        reset_credits_available: reset_credits,
        windows,
        error: None,
        reason: None,
    }
}

// ---------------------------------------------------------------------------
// IO: the App Server read (codex_fetcher.js)
// ---------------------------------------------------------------------------

const REQUEST_ID: u64 = 2;

#[derive(Debug, Clone)]
pub struct CodexConfig {
    pub app_server_argv: Vec<String>,
    pub timeout: Duration,
}

impl Default for CodexConfig {
    fn default() -> Self {
        Self {
            app_server_argv: vec!["codex".into(), "app-server".into()],
            timeout: Duration::from_secs(15),
        }
    }
}

fn request_text() -> String {
    let messages = [
        serde_json::json!({
            "method": "initialize",
            "id": 0,
            "params": {"clientInfo": {
                "name": "claudometer",
                "title": "Claudometer",
                "version": env!("CARGO_PKG_VERSION"),
            }},
        }),
        serde_json::json!({"method": "initialized", "params": {}}),
        serde_json::json!({"method": "account/rateLimits/read", "id": REQUEST_ID}),
    ];
    let mut text = String::new();
    for message in messages {
        text.push_str(&message.to_string());
        text.push('\n');
    }
    text
}

/// Always resolves to a Codex snapshot. Notifications and initialization
/// responses are skipped until the matching quota reply; any malformed
/// protocol line fails closed instead of guessing at usage.
pub async fn fetch_codex_snapshot(config: &CodexConfig, now: i64) -> CodexSnapshot {
    let mut argv = config.app_server_argv.clone();
    let Some(program) = argv.first().cloned() else {
        return CodexSnapshot::failed(now, ProviderError::ReadFailed, Some("empty-argv"));
    };
    let command = if program.contains('/') {
        PathBuf::from(&program)
    } else {
        match resolve_cli_default(&program) {
            Some(resolved) => resolved,
            None => return CodexSnapshot::failed(now, ProviderError::NotInstalled, None),
        }
    };
    argv.remove(0);

    let mut process = tokio::process::Command::new(&command);
    process
        .args(&argv)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return CodexSnapshot::failed(now, ProviderError::NotInstalled, None);
        }
        Err(_) => {
            return CodexSnapshot::failed(now, ProviderError::ReadFailed, Some("spawn-failed"));
        }
    };
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill().await;
        return CodexSnapshot::failed(now, ProviderError::ReadFailed, Some("no-pipes"));
    };

    let exchange = async {
        if stdin.write_all(request_text().as_bytes()).await.is_err() {
            return CodexSnapshot::failed(now, ProviderError::ReadFailed, Some("write-failed"));
        }
        let _ = stdin.flush().await;
        let mut lines = BufReader::new(stdout).lines();
        loop {
            let line = match lines.next_line().await {
                Ok(Some(line)) => line,
                Ok(None) => {
                    return CodexSnapshot::failed(
                        now,
                        ProviderError::ReadFailed,
                        Some("early-eof"),
                    );
                }
                Err(_) => {
                    return CodexSnapshot::failed(
                        now,
                        ProviderError::ReadFailed,
                        Some("read-failed"),
                    );
                }
            };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                return CodexSnapshot::failed(now, ProviderError::ReadFailed, Some("bad-json"));
            };
            if message.get("id").and_then(Value::as_u64) != Some(REQUEST_ID) {
                continue;
            }
            if message.get("error").is_some() {
                return CodexSnapshot::failed(now, ProviderError::ReadFailed, Some("server-error"));
            }
            return match message.get("result") {
                Some(result) => parse_codex_rate_limits(result, now),
                None => CodexSnapshot::failed(now, ProviderError::ReadFailed, Some("server-error")),
            };
        }
    };
    let snapshot = match tokio::time::timeout(config.timeout, exchange).await {
        Ok(snapshot) => snapshot,
        Err(_) => CodexSnapshot::failed(now, ProviderError::ReadFailed, Some("timeout")),
    };
    // The server is only needed for the one read: stop it and reap it before
    // anyone observes the result (no lingering process, no zombie).
    drop(stdin);
    let _ = child.kill().await;
    snapshot
}

// ---------------------------------------------------------------------------
// Policy (codex_source.js)
// ---------------------------------------------------------------------------

pub const DEFAULT_CODEX_REFRESH_AFTER_MS: i64 = 60_000;
pub const MAX_CODEX_INEFFECTIVE_REFRESHES: u32 = 3;

pub struct CodexSource {
    config: CodexConfig,
    refresh_after_ms: i64,
    last_good: Option<CodexSnapshot>,
    last_failure: Option<CodexSnapshot>,
    last_warned: Option<String>,
    ineffective_refreshes: u32,
    last_refresh_failed: bool,
}

impl CodexSource {
    pub fn new(config: CodexConfig) -> Self {
        Self {
            config,
            refresh_after_ms: DEFAULT_CODEX_REFRESH_AFTER_MS,
            last_good: None,
            last_failure: None,
            last_warned: None,
            ineffective_refreshes: 0,
            last_refresh_failed: false,
        }
    }

    pub fn last_refresh_failed(&self) -> bool {
        self.last_refresh_failed
    }

    /// Query the App Server at the configured cadence, retain the last
    /// successful snapshot across transient failures, and stop repeated
    /// process attempts after three initial failures (manual re-arms).
    pub async fn fetch(&mut self, now: i64, manual: bool) -> CodexSnapshot {
        if manual {
            self.ineffective_refreshes = 0;
        }
        if !self.wants_refresh(now, manual) {
            return self
                .last_good
                .clone()
                .or_else(|| self.last_failure.clone())
                .unwrap_or_else(|| CodexSnapshot::failed(now, ProviderError::ReadFailed, None));
        }
        self.apply(fetch_codex_snapshot(&self.config, now).await)
    }

    /// Fold a fetch result into the policy state; split from `fetch` so the
    /// policy is testable without a real App Server.
    fn apply(&mut self, snapshot: CodexSnapshot) -> CodexSnapshot {
        if !snapshot.is_error() {
            self.last_good = Some(snapshot.clone());
            self.last_failure = None;
            self.last_warned = None;
            self.ineffective_refreshes = 0;
            self.last_refresh_failed = false;
            return snapshot;
        }
        self.last_failure = Some(snapshot.clone());
        self.last_refresh_failed = true;
        self.report_failure(&snapshot);
        if let Some(good) = &self.last_good {
            return good.clone();
        }
        self.ineffective_refreshes += 1;
        if self.ineffective_refreshes == MAX_CODEX_INEFFECTIVE_REFRESHES {
            eprintln!(
                "claudometer: Codex usage reads suspended after \
                 {MAX_CODEX_INEFFECTIVE_REFRESHES} failed attempts; manual refresh re-arms"
            );
        }
        snapshot
    }

    fn wants_refresh(&self, now: i64, manual: bool) -> bool {
        if manual {
            return true;
        }
        match &self.last_good {
            None => self.ineffective_refreshes < MAX_CODEX_INEFFECTIVE_REFRESHES,
            Some(good) => now - good.fetched_at >= self.refresh_after_ms,
        }
    }

    fn report_failure(&mut self, snapshot: &CodexSnapshot) {
        let key = format!("{:?}:{}", snapshot.error, snapshot.reason.unwrap_or(""));
        if self.last_warned.as_deref() == Some(key.as_str()) {
            return;
        }
        self.last_warned = Some(key.clone());
        eprintln!("claudometer: Codex usage read failed ({key})");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RESULT: &str = include_str!("../../tests/fixtures/codex-rate-limits-result.json");
    const RESPONSE: &str = include_str!("../../tests/fixtures/codex-app-server-response.json");

    #[test]
    fn parses_the_real_capture_main_bucket_first() {
        let result: Value = serde_json::from_str(RESULT).unwrap();
        let snapshot = parse_codex_rate_limits(&result, 7);
        assert_eq!(snapshot.error, None);
        assert_eq!(snapshot.fetched_at, 7);
        assert_eq!(snapshot.main_limit_id.as_deref(), Some("codex"));
        assert_eq!(snapshot.access, Access::Allowed);
        assert_eq!(snapshot.reset_credits_available, Some(2));
        let ids: Vec<(&str, Slot, f64)> = snapshot
            .windows
            .iter()
            .map(|w| (w.limit_id.as_str(), w.slot, w.percent))
            .collect();
        // The fixture map arrives model-specific first; the main bucket still
        // leads, and the Spark bucket keeps both its windows.
        assert_eq!(
            ids,
            [
                ("codex", Slot::Primary, 31.0),
                ("codex_bengalfox", Slot::Primary, 12.0),
                ("codex_bengalfox", Slot::Secondary, 18.0),
            ]
        );
        assert_eq!(snapshot.windows[0].duration_mins, Some(10080.0));
        assert_eq!(snapshot.windows[0].resets_at, Some(1786930515000));
        assert_eq!(
            snapshot.windows[1].limit_name.as_deref(),
            Some("GPT-5.3-Codex-Spark")
        );

        let envelope: Value = serde_json::from_str(RESPONSE).unwrap();
        assert_eq!(parse_codex_rate_limits(&envelope["result"], 7), snapshot);
    }

    #[test]
    fn legacy_projection_only_and_access_states() {
        let result = serde_json::json!({
            "rateLimits": {"primary": {"usedPercent": 50}},
            "ordinaryUsageAllowed": null,
        });
        let snapshot = parse_codex_rate_limits(&result, 1);
        assert_eq!(snapshot.error, None);
        assert_eq!(snapshot.main_limit_id.as_deref(), Some("codex"));
        assert_eq!(snapshot.access, Access::Unknown);
        assert_eq!(snapshot.windows.len(), 1);

        let denied = serde_json::json!({
            "rateLimits": {"limitId": "codex", "primary": {"usedPercent": 50}},
            "ordinaryUsageAllowed": false,
        });
        assert_eq!(parse_codex_rate_limits(&denied, 1).access, Access::Denied);
        assert_eq!(
            parse_codex_rate_limits(&serde_json::json!({"rateLimits": null}), 1).error,
            Some(ProviderError::NotAuthenticated)
        );
        assert_eq!(
            parse_codex_rate_limits(&serde_json::json!({}), 1).error,
            Some(ProviderError::NotAuthenticated)
        );
    }

    #[test]
    fn drift_is_unparseable() {
        for result in [
            serde_json::json!([]),
            serde_json::json!({"rateLimits": {"primary": {"usedPercent": "50"}}}),
            serde_json::json!({"rateLimits": {"primary": {"usedPercent": 5, "resetsAt": -1}}}),
            serde_json::json!({"rateLimits": {"primary": {"usedPercent": 5}}, "ordinaryUsageAllowed": "yes"}),
            serde_json::json!({"rateLimits": {"primary": {"usedPercent": 5}}, "rateLimitResetCredits": {"availableCount": -1}}),
            serde_json::json!({"rateLimitsByLimitId": [], "rateLimits": {"primary": {"usedPercent": 5}}}),
            serde_json::json!({"rateLimits": {"limitId": "", "primary": {"usedPercent": 5}}}),
        ] {
            assert_eq!(
                parse_codex_rate_limits(&result, 1).error,
                Some(ProviderError::Unparseable),
                "{result}"
            );
        }
    }

    #[test]
    fn source_retains_last_good_across_transient_failures_and_gives_up_cold() {
        let good = parse_codex_rate_limits(&serde_json::from_str(RESULT).unwrap(), 100);
        let mut source = CodexSource::new(CodexConfig::default());
        assert_eq!(source.apply(good.clone()), good);
        let failure = CodexSnapshot::failed(200, ProviderError::ReadFailed, Some("timeout"));
        assert_eq!(source.apply(failure.clone()), good);
        assert!(source.last_refresh_failed());
        // Cadence: no re-query before the interval, re-query after it.
        assert!(!source.wants_refresh(100 + 30_000, false));
        assert!(source.wants_refresh(100 + 60_000, false));
        assert!(source.wants_refresh(100, true));

        let mut cold = CodexSource::new(CodexConfig::default());
        for _ in 0..MAX_CODEX_INEFFECTIVE_REFRESHES {
            assert!(cold.wants_refresh(0, false));
            assert_eq!(cold.apply(failure.clone()), failure);
        }
        assert!(!cold.wants_refresh(0, false));
        assert!(cold.wants_refresh(0, true));
    }

    #[tokio::test]
    async fn missing_codex_binary_is_not_installed() {
        let config = CodexConfig {
            app_server_argv: vec!["/nonexistent/codex".into(), "app-server".into()],
            timeout: Duration::from_secs(1),
        };
        let snapshot = fetch_codex_snapshot(&config, 3).await;
        assert_eq!(snapshot.error, Some(ProviderError::NotInstalled));
        assert_eq!(snapshot.fetched_at, 3);
    }

    #[tokio::test]
    async fn fake_app_server_round_trip_and_timeout() {
        let fake = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/fixtures/bin/codex-app-server"
        );
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/fixtures/codex-app-server-response.json"
        );
        let config = CodexConfig {
            app_server_argv: vec![fake.into(), "emit-file".into(), fixture.into()],
            timeout: Duration::from_secs(5),
        };
        let snapshot = fetch_codex_snapshot(&config, 9).await;
        assert_eq!(snapshot.error, None, "{:?}", snapshot.reason);
        assert_eq!(snapshot.main_limit_id.as_deref(), Some("codex"));

        let garbage = CodexConfig {
            app_server_argv: vec![fake.into(), "emit-garbage".into()],
            timeout: Duration::from_secs(5),
        };
        let snapshot = fetch_codex_snapshot(&garbage, 9).await;
        assert_eq!(snapshot.error, Some(ProviderError::ReadFailed));
        assert_eq!(snapshot.reason, Some("bad-json"));

        let pid_file =
            std::env::temp_dir().join(format!("claudometer-hang-{}", std::process::id()));
        let hang = CodexConfig {
            app_server_argv: vec![fake.into(), "hang".into(), pid_file.display().to_string()],
            timeout: Duration::from_millis(500),
        };
        let snapshot = fetch_codex_snapshot(&hang, 9).await;
        assert_eq!(snapshot.reason, Some("timeout"));
        // The hung fake is killed, not leaked.
        if let Ok(pid) = std::fs::read_to_string(&pid_file) {
            let alive = std::path::Path::new(&format!("/proc/{}", pid.trim())).exists();
            assert!(!alive, "hung app-server {pid} still running");
        }
        let _ = std::fs::remove_file(pid_file);
    }
}
