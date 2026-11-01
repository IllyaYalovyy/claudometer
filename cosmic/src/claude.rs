//! The Claude Code provider (RFC-001 Option C): the `cachedUsageUtilization`
//! object in `~/.claude.json` is the only parse surface; the proven
//! token-free `claude -p /usage --output-format json` spawn only refreshes
//! it, behind the G1 zero-cost tripwire.
//!
//! Port of `src/lib/snapshot.js`, `src/lib/fetcher.js` and
//! `src/lib/source.js`. Everything in this module runs on the applet's
//! tokio executor thread, never on the UI thread.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value};

/// Failure taxonomy shared by both providers (RFC-001 Design).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderError {
    /// The client was never run here (cache absent) or is not on `PATH`.
    NotInstalled,
    /// The client exists but is signed out, API-key-only, or has no usable
    /// quota data.
    NotAuthenticated,
    /// Schema drift or an unreadable file: never coerced, never guessed.
    Unparseable,
    /// RFC-002 Codex process/protocol failure (transient; backoff handles it).
    ReadFailed,
}

/// One rate-limit window: percent used (clamped 0–100) and the epoch-ms
/// reset time when the source reported one.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageWindow {
    pub percent: f64,
    pub resets_at: Option<i64>,
}

/// A per-model weekly window (`weekly_scoped`), named by its display name.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelWindow {
    pub model: String,
    pub window: UsageWindow,
}

/// The UX-DESIGN §2 Claude display contract. Error snapshots carry only
/// `fetched_at` (the attempt time) and `error`.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeSnapshot {
    pub fetched_at: i64,
    pub session: Option<UsageWindow>,
    pub week: Option<UsageWindow>,
    pub week_model: Vec<ModelWindow>,
    pub error: Option<ProviderError>,
}

impl ClaudeSnapshot {
    pub fn failed(now: i64, error: ProviderError) -> Self {
        Self {
            fetched_at: now,
            session: None,
            week: None,
            week_model: Vec::new(),
            error: Some(error),
        }
    }

    pub fn is_error(&self) -> bool {
        self.error.is_some()
    }
}

#[derive(Deserialize)]
struct Root {
    #[serde(rename = "cachedUsageUtilization")]
    cached: Option<Value>,
}

fn parse_percent(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64()?;
    number.is_finite().then(|| number.clamp(0.0, 100.0))
}

/// Strict ISO 8601 with an explicit offset — the only reset-time format the
/// cache has ever carried. Anything else is drift, not something to hand to
/// a lenient parser.
fn parse_resets_at(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|t| t.timestamp_millis())
}

/// Parse the raw `~/.claude.json` bytes. `now` is used as `fetched_at` only
/// for error snapshots, which have no honest source timestamp.
pub fn parse_snapshot(raw: &[u8], now: i64) -> ClaudeSnapshot {
    let unparseable = ClaudeSnapshot::failed(now, ProviderError::Unparseable);
    let Ok(root) = serde_json::from_slice::<Root>(raw) else {
        return unparseable;
    };
    // Absent/null cache in an otherwise well-formed file is the signed-out
    // or API-key-only state, not a parse failure.
    let cache = match root.cached {
        None | Some(Value::Null) => {
            return ClaudeSnapshot::failed(now, ProviderError::NotAuthenticated);
        }
        Some(Value::Object(cache)) => cache,
        Some(_) => return unparseable,
    };
    let fetched_at = match cache.get("fetchedAtMs").and_then(Value::as_i64) {
        Some(ms) if ms > 0 => ms,
        _ => return unparseable,
    };
    let Some(limits) = cache
        .get("utilization")
        .and_then(Value::as_object)
        .and_then(|u| u.get("limits"))
        .and_then(Value::as_array)
    else {
        return unparseable;
    };

    let mut snapshot = ClaudeSnapshot {
        fetched_at,
        session: None,
        week: None,
        week_model: Vec::new(),
        error: None,
    };
    for limit in limits {
        let Some(limit) = limit.as_object() else {
            return unparseable;
        };
        let Some(kind) = limit.get("kind").and_then(Value::as_str) else {
            return unparseable;
        };
        // Unknown kinds are skipped without validation so future CLI window
        // types cannot break parsing.
        if !matches!(kind, "session" | "weekly_all" | "weekly_scoped") {
            continue;
        }
        let Some(percent) = parse_percent(limit.get("percent")) else {
            return unparseable;
        };
        let resets_at = match limit.get("resets_at") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => match parse_resets_at(text) {
                Some(ms) => Some(ms),
                None => return unparseable,
            },
            Some(_) => return unparseable,
        };
        let window = UsageWindow { percent, resets_at };
        match kind {
            "session" => {
                snapshot.session.get_or_insert(window);
            }
            "weekly_all" => {
                snapshot.week.get_or_insert(window);
            }
            _ => {
                let model = limit
                    .get("scope")
                    .and_then(Value::as_object)
                    .and_then(|s| s.get("model"))
                    .and_then(Value::as_object)
                    .and_then(|m| m.get("display_name"))
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty());
                let Some(model) = model else {
                    return unparseable;
                };
                snapshot.week_model.push(ModelWindow {
                    model: model.to_owned(),
                    window,
                });
            }
        }
    }
    snapshot
}

// ---------------------------------------------------------------------------
// IO: file read and the injectable refresh spawn (fetcher.js)
// ---------------------------------------------------------------------------

/// Refresh outcomes beyond the parser's taxonomy: `RefreshFailed` covers the
/// transient spawn failures backoff handles; `ModelInvoked` is the
/// fail-closed G1 tripwire — a structurally valid CLI envelope on which the
/// zero-cost invariants cannot be asserted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshError {
    NotInstalled,
    RefreshFailed,
    ModelInvoked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshFailure {
    pub error: RefreshError,
    pub reason: Option<&'static str>,
    pub command: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct ClaudeConfig {
    pub file_path: PathBuf,
    pub refresh_argv: Vec<String>,
    pub refresh_timeout: Duration,
}

impl Default for ClaudeConfig {
    fn default() -> Self {
        Self {
            file_path: dirs::home_dir().unwrap_or_default().join(".claude.json"),
            refresh_argv: ["claude", "-p", "/usage", "--output-format", "json"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            // Far above the observed ~300 ms envelope runs, below the poll tick.
            refresh_timeout: Duration::from_secs(30),
        }
    }
}

/// The panel's `PATH` is a session manager's, not a login shell's, so a
/// user-level `claude`/`codex` install may be invisible to a bare lookup.
/// Resolve each `PATH` dir first, then `~/.local/bin` and `~/bin`. A hit is
/// an executable regular file.
pub fn resolve_cli(name: &str, path_env: Option<&str>, home: Option<&Path>) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let mut dirs: Vec<PathBuf> = path_env
        .unwrap_or("")
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .collect();
    if let Some(home) = home {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join("bin"));
    }
    dirs.into_iter()
        .map(|dir| dir.join(name))
        .find(|candidate| {
            std::fs::metadata(candidate)
                .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        })
}

pub fn resolve_cli_default(name: &str) -> Option<PathBuf> {
    let path = std::env::var("PATH").ok();
    resolve_cli(name, path.as_deref(), dirs::home_dir().as_deref())
}

/// Read + parse in one step: always resolves to a snapshot (error snapshots
/// included), so a fetch can never panic or throw into the caller.
pub async fn fetch_snapshot(path: &Path, now: i64) -> ClaudeSnapshot {
    match tokio::fs::read(path).await {
        Ok(bytes) => parse_snapshot(&bytes, now),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            ClaudeSnapshot::failed(now, ProviderError::NotInstalled)
        }
        Err(_) => ClaudeSnapshot::failed(now, ProviderError::Unparseable),
    }
}

fn is_zero(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64) == Some(0.0)
}

/// G1 tripwire (RFC-001 drift detection 2): the envelope must positively
/// assert zero model involvement; wrong-typed or missing counters fail too.
fn asserts_zero_cost(envelope: &Map<String, Value>) -> bool {
    if !is_zero(envelope.get("num_turns"))
        || !is_zero(envelope.get("duration_api_ms"))
        || !is_zero(envelope.get("total_cost_usd"))
    {
        return false;
    }
    match envelope.get("modelUsage").and_then(Value::as_object) {
        Some(usage) if usage.is_empty() => {}
        _ => return false,
    }
    let Some(usage) = envelope.get("usage").and_then(Value::as_object) else {
        return false;
    };
    [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .iter()
    .all(|key| is_zero(usage.get(*key)))
}

/// The CLI's stdout is a health signal only — never a data source. Non-JSON
/// output is transient breakage for backoff; a real envelope failing the
/// zero-cost assertion is the tripwire.
pub fn classify_envelope(stdout: &[u8]) -> Result<(), (RefreshError, Option<&'static str>)> {
    let Ok(Value::Object(envelope)) = serde_json::from_slice::<Value>(stdout) else {
        return Err((RefreshError::RefreshFailed, Some("bad-envelope")));
    };
    if !asserts_zero_cost(&envelope) {
        return Err((RefreshError::ModelInvoked, None));
    }
    if envelope.get("is_error") != Some(&Value::Bool(false)) {
        return Err((RefreshError::RefreshFailed, Some("cli-error")));
    }
    Ok(())
}

/// Spawn the refresh command and report its health; nothing from the spawn
/// is parsed into usage data. A hang is killed at the timeout and reaped.
pub async fn refresh_cache(config: &ClaudeConfig) -> Result<(), RefreshFailure> {
    let mut argv = config.refresh_argv.clone();
    let Some(program) = argv.first().cloned() else {
        return Err(RefreshFailure {
            error: RefreshError::RefreshFailed,
            reason: Some("empty-argv"),
            command: None,
        });
    };
    let command = if program.contains('/') {
        PathBuf::from(&program)
    } else {
        match resolve_cli_default(&program) {
            Some(resolved) => resolved,
            None => {
                return Err(RefreshFailure {
                    error: RefreshError::NotInstalled,
                    reason: None,
                    command: Some(PathBuf::from(program)),
                });
            }
        }
    };
    argv.remove(0);
    let failure = |error, reason| RefreshFailure {
        error,
        reason,
        command: Some(command.clone()),
    };

    let mut process = tokio::process::Command::new(&command);
    process
        .args(&argv)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = match tokio::time::timeout(config.refresh_timeout, process.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(failure(RefreshError::NotInstalled, None));
        }
        Ok(Err(_)) => return Err(failure(RefreshError::RefreshFailed, Some("spawn-failed"))),
        Err(_) => return Err(failure(RefreshError::RefreshFailed, Some("timeout"))),
    };
    if !output.status.success() {
        return Err(failure(RefreshError::RefreshFailed, Some("nonzero-exit")));
    }
    classify_envelope(&output.stdout).map_err(|(error, reason)| failure(error, reason))
}

// ---------------------------------------------------------------------------
// Policy: when to spawn (source.js)
// ---------------------------------------------------------------------------

/// The staleness threshold that triggers a refresh spawn; the UX §6 poll
/// interval, which also spaces spawns at least one poll apart.
pub const DEFAULT_REFRESH_AFTER_MS: i64 = 60_000;

/// #19 polite give-up: consecutive refresh spawns that still leave the file
/// read in error before auto-spawning suspends (manual re-arms).
pub const MAX_INEFFECTIVE_REFRESHES: u32 = 3;

pub struct ClaudeSource {
    config: ClaudeConfig,
    refresh_after_ms: i64,
    /// The G1 tripwire latch, shared with the applet so a settings change
    /// re-arms (or disables) the path without locking the source.
    refresh_disabled: Arc<AtomicBool>,
    ineffective_refreshes: u32,
    last_refresh_failed: bool,
    last_warned: Option<String>,
}

impl ClaudeSource {
    pub fn new(config: ClaudeConfig, refresh_disabled: Arc<AtomicBool>) -> Self {
        Self {
            config,
            refresh_after_ms: DEFAULT_REFRESH_AFTER_MS,
            refresh_disabled,
            ineffective_refreshes: 0,
            last_refresh_failed: false,
            last_warned: None,
        }
    }

    /// Whether the most recent refresh spawn failed (#16). Old data alone is
    /// not evidence: the CLI throttles rewrites of its cache.
    pub fn last_refresh_failed(&self) -> bool {
        self.last_refresh_failed
    }

    /// Whether the G1 tripwire has fired and the CLI refresh path is off.
    /// `false` only ever arrives from the applet mirroring an explicit user
    /// action; nothing in this module clears the latch.
    pub fn refresh_disabled(&self) -> bool {
        self.refresh_disabled.load(Ordering::Relaxed)
    }

    pub async fn fetch(&mut self, now: i64, manual: bool) -> ClaudeSnapshot {
        if manual {
            self.ineffective_refreshes = 0;
        }
        let snapshot = fetch_snapshot(&self.config.file_path, now).await;
        if !self.wants_refresh(&snapshot, now, manual) {
            return snapshot;
        }
        match refresh_cache(&self.config).await {
            Ok(()) => {
                self.last_refresh_failed = false;
                self.last_warned = None;
            }
            Err(failure) => {
                self.last_refresh_failed = true;
                self.report_failure(&failure);
            }
        }
        // Re-read regardless of the verdict: only the file says what the
        // data now is.
        let refreshed = fetch_snapshot(&self.config.file_path, now).await;
        self.count_refresh_effect(&refreshed);
        refreshed
    }

    fn wants_refresh(&self, snapshot: &ClaudeSnapshot, now: i64, manual: bool) -> bool {
        if self.refresh_disabled() {
            return false;
        }
        if manual {
            return true;
        }
        if snapshot.is_error() {
            return self.ineffective_refreshes < MAX_INEFFECTIVE_REFRESHES;
        }
        now - snapshot.fetched_at > self.refresh_after_ms
    }

    fn count_refresh_effect(&mut self, snapshot: &ClaudeSnapshot) {
        if !snapshot.is_error() {
            self.ineffective_refreshes = 0;
            return;
        }
        self.ineffective_refreshes += 1;
        if self.ineffective_refreshes == MAX_INEFFECTIVE_REFRESHES {
            eprintln!(
                "claudometer: refresh path suspended after {MAX_INEFFECTIVE_REFRESHES} \
                 ineffective attempts; manual refresh re-arms"
            );
        }
    }

    /// Raw causes go to the log, never to the UI. Repeats are logged once.
    fn report_failure(&mut self, failure: &RefreshFailure) {
        if failure.error == RefreshError::ModelInvoked {
            self.refresh_disabled.store(true, Ordering::Relaxed);
            eprintln!(
                "claudometer: refresh envelope could not prove zero model cost; \
                 permanently disabling the CLI refresh path (RFC-001 G1 tripwire)"
            );
            return;
        }
        let key = format!("{:?}:{}", failure.error, failure.reason.unwrap_or(""));
        if self.last_warned.as_deref() == Some(key.as_str()) {
            return;
        }
        self.last_warned = Some(key);
        eprintln!(
            "claudometer: cache refresh failed: {:?}{}{}",
            failure.error,
            failure
                .reason
                .map(|r| format!(" ({r})"))
                .unwrap_or_default(),
            failure
                .command
                .as_ref()
                .map(|c| format!("; command: {}", c.display()))
                .unwrap_or_default(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CACHE: &str = include_str!("../../tests/fixtures/cached-usage-utilization.json");
    const ENVELOPE: &str = include_str!("../../tests/fixtures/claude-p-usage-result.json");
    const SIGNED_OUT: &str = include_str!("../../tests/fixtures/claude-p-usage-signed-out.json");

    fn wrapped(cache: &str) -> Vec<u8> {
        format!(r#"{{"numStartups": 3, "cachedUsageUtilization": {cache}}}"#).into_bytes()
    }

    #[test]
    fn parses_the_real_capture() {
        let snapshot = parse_snapshot(&wrapped(CACHE), 1);
        assert_eq!(snapshot.error, None);
        assert_eq!(snapshot.fetched_at, 1784959900803);
        let session = snapshot.session.as_ref().unwrap();
        assert_eq!(session.percent, 27.0);
        assert_eq!(session.resets_at, Some(1784975999696));
        let week = snapshot.week.as_ref().unwrap();
        assert_eq!(week.percent, 34.0);
        assert_eq!(snapshot.week_model.len(), 1);
        assert_eq!(snapshot.week_model[0].model, "Fable");
        assert_eq!(snapshot.week_model[0].window.percent, 17.0);
    }

    #[test]
    fn absent_or_null_cache_is_not_authenticated() {
        let snapshot = parse_snapshot(br#"{"numStartups": 1}"#, 5);
        assert_eq!(snapshot.error, Some(ProviderError::NotAuthenticated));
        assert_eq!(snapshot.fetched_at, 5);
        let snapshot = parse_snapshot(br#"{"cachedUsageUtilization": null}"#, 5);
        assert_eq!(snapshot.error, Some(ProviderError::NotAuthenticated));
    }

    #[test]
    fn drift_is_unparseable_never_coerced() {
        for raw in [
            &b"not json"[..],
            br#"[]"#,
            br#"{"cachedUsageUtilization": 3}"#,
            br#"{"cachedUsageUtilization": {"fetchedAtMs": "1", "utilization": {"limits": []}}}"#,
            br#"{"cachedUsageUtilization": {"fetchedAtMs": 1, "utilization": {}}}"#,
            br#"{"cachedUsageUtilization": {"fetchedAtMs": 1, "utilization": {"limits": [{"kind": "session", "percent": "27"}]}}}"#,
            br#"{"cachedUsageUtilization": {"fetchedAtMs": 1, "utilization": {"limits": [{"kind": "session", "percent": 1, "resets_at": "Jul 25, 3:39am"}]}}}"#,
            br#"{"cachedUsageUtilization": {"fetchedAtMs": 1, "utilization": {"limits": [{"kind": "weekly_scoped", "percent": 1, "scope": {"model": {}}}]}}}"#,
        ] {
            let snapshot = parse_snapshot(raw, 9);
            assert_eq!(
                snapshot.error,
                Some(ProviderError::Unparseable),
                "{}",
                String::from_utf8_lossy(raw)
            );
        }
    }

    #[test]
    fn unknown_kinds_and_missing_resets_are_tolerated() {
        let snapshot = parse_snapshot(
            br#"{"cachedUsageUtilization": {"fetchedAtMs": 10, "utilization": {"limits": [
                {"kind": "future_window", "percent": "whatever"},
                {"kind": "session", "percent": 140, "resets_at": null},
                {"kind": "session", "percent": 5}
            ]}}}"#,
            1,
        );
        assert_eq!(snapshot.error, None);
        assert_eq!(
            snapshot.session,
            Some(UsageWindow {
                percent: 100.0,
                resets_at: None
            })
        );
        assert_eq!(snapshot.week, None);
    }

    #[test]
    fn real_envelope_passes_the_tripwire_and_mutations_trip_it() {
        assert_eq!(classify_envelope(ENVELOPE.as_bytes()), Ok(()));
        assert_eq!(classify_envelope(SIGNED_OUT.as_bytes()), Ok(()));
        let mut envelope: Value = serde_json::from_str(ENVELOPE).unwrap();
        envelope["total_cost_usd"] = Value::from(0.01);
        assert_eq!(
            classify_envelope(envelope.to_string().as_bytes()),
            Err((RefreshError::ModelInvoked, None))
        );
        let mut envelope: Value = serde_json::from_str(ENVELOPE).unwrap();
        envelope["modelUsage"] = serde_json::json!({"claude": {"inputTokens": 1}});
        assert_eq!(
            classify_envelope(envelope.to_string().as_bytes()),
            Err((RefreshError::ModelInvoked, None))
        );
        let mut envelope: Value = serde_json::from_str(ENVELOPE).unwrap();
        envelope["usage"]["output_tokens"] = Value::from("0");
        assert_eq!(
            classify_envelope(envelope.to_string().as_bytes()),
            Err((RefreshError::ModelInvoked, None))
        );
        let mut envelope: Value = serde_json::from_str(ENVELOPE).unwrap();
        envelope["is_error"] = Value::Bool(true);
        assert_eq!(
            classify_envelope(envelope.to_string().as_bytes()),
            Err((RefreshError::RefreshFailed, Some("cli-error")))
        );
        assert_eq!(
            classify_envelope(b"garbage"),
            Err((RefreshError::RefreshFailed, Some("bad-envelope")))
        );
    }

    #[test]
    fn resolves_executables_on_path_and_user_bins() {
        let dir = std::env::temp_dir().join(format!("claudometer-resolve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let bin = dir.join("home").join(".local").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join("claude");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        assert_eq!(
            resolve_cli("claude", Some("/nonexistent"), Some(&dir.join("home"))),
            None
        );
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            resolve_cli("claude", Some("/nonexistent"), Some(&dir.join("home"))),
            Some(exe.clone())
        );
        assert_eq!(
            resolve_cli("claude", Some(&format!(":{}", bin.display())), None),
            Some(exe)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn source_serves_the_file_and_gates_spawns() {
        let dir = std::env::temp_dir().join(format!("claudometer-source-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("claude.json");
        std::fs::write(&file, wrapped(CACHE)).unwrap();
        let config = ClaudeConfig {
            file_path: file.clone(),
            refresh_argv: vec!["/bin/false".into()],
            refresh_timeout: Duration::from_secs(2),
        };
        let mut source = ClaudeSource::new(config.clone(), Arc::new(AtomicBool::new(false)));
        // Fresh cache: no spawn, last_refresh_failed untouched.
        let snapshot = source.fetch(1784959900803 + 1_000, false).await;
        assert_eq!(snapshot.error, None);
        assert!(!source.last_refresh_failed());
        // Stale cache: the spawn runs (and fails), the file is still served.
        let snapshot = source.fetch(1784959900803 + 10 * 60_000, false).await;
        assert_eq!(snapshot.error, None);
        assert!(source.last_refresh_failed());
        // Disabled path: never spawns even when manual.
        let mut disabled = ClaudeSource::new(config, Arc::new(AtomicBool::new(true)));
        let snapshot = disabled.fetch(1784959900803 + 10 * 60_000, true).await;
        assert_eq!(snapshot.error, None);
        assert!(!disabled.last_refresh_failed());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
