//! Pure render models map snapshots, times, and settings to
//! what the panel and the popup should show. No widget imports, so every
//! display decision is unit-testable; `window.rs` renders 1:1.

use chrono::{DateTime, Local, TimeZone};

use crate::claude::{ClaudeSnapshot, ProviderError};
use crate::codex::{Access, CodexSnapshot, CodexWindow};
use crate::marks::Mark;
use crate::source::{RefreshFailed, Snapshot};

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;

/// Provider states in precedence order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Normal,
    Warning,
    Critical,
    LimitHit,
    Stale,
    Unavailable,
}

/// §3.3: stale/unavailable render at 55% opacity.
pub const DIM_OPACITY: f32 = 0.55;

/// The §7 preferences plus the system facts the models need, built once per
/// settings change by the window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Options {
    pub warning_at: f64,
    pub critical_at: f64,
    pub stale_after_ms: i64,
    pub clock24: bool,
    pub last_refresh_failed: RefreshFailed,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            warning_at: 80.0,
            critical_at: 95.0,
            stale_after_ms: 3 * MINUTE_MS,
            clock24: true,
            last_refresh_failed: RefreshFailed::default(),
        }
    }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

pub fn format_percent(p: f64) -> String {
    format!("{}%", p.round() as i64)
}

/// §4.3 countdown: "2 h 15 m", "12 m", "1 h"; under a minute is "<1 min".
/// Sub-minute remainders truncate — a countdown must never overpromise.
pub fn format_countdown(ms: i64) -> String {
    if ms < MINUTE_MS {
        return "<1 min".to_owned();
    }
    let hours = ms / HOUR_MS;
    let minutes = (ms % HOUR_MS) / MINUTE_MS;
    if hours == 0 {
        format!("{minutes} m")
    } else if minutes == 0 {
        format!("{hours} h")
    } else {
        format!("{hours} h {minutes} m")
    }
}

fn local(ms: i64) -> Option<DateTime<Local>> {
    Local.timestamp_millis_opt(ms).single()
}

fn format_clock(time: &DateTime<Local>, clock24: bool) -> String {
    if clock24 {
        time.format("%H:%M").to_string()
    } else {
        time.format("%-I:%M %p").to_string()
    }
}

/// §4.3 reset row: relative + absolute together within 24 h ("Resets in
/// 2 h 15 m (17:00)"); beyond 24 h the countdown is noise, so date only
/// ("Resets Tue, Jul 28"). Exactly 24 h away still counts down.
pub fn format_reset_row(resets_at: i64, now: i64, clock24: bool) -> String {
    let remaining = resets_at - now;
    let Some(reset) = local(resets_at) else {
        return format!("Resets in {}", format_countdown(remaining));
    };
    if remaining > DAY_MS {
        return format!("Resets {}", reset.format("%a, %b %-d"));
    }
    format!(
        "Resets in {} ({})",
        format_countdown(remaining),
        format_clock(&reset, clock24)
    )
}

/// Stale ages read in "min"/"h min" (footer prose), unlike the terse
/// countdown units — §4.4 vs §4.3.
pub fn format_age(ms: i64) -> String {
    let hours = ms / HOUR_MS;
    let minutes = (ms % HOUR_MS) / MINUTE_MS;
    if hours == 0 {
        format!("{minutes} min")
    } else if minutes == 0 {
        format!("{hours} h")
    } else {
        format!("{hours} h {minutes} min")
    }
}

fn round_minutes(ms: i64) -> i64 {
    (ms as f64 / MINUTE_MS as f64).round() as i64
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeKind {
    Session,
    Week,
    WeekModel,
}

/// The Claude window the user will hit first: highest percent across session,
/// week, and per-model weekly entries. Ties break toward the earlier window
/// in that fixed order, so the headline cannot flap between near-equal
/// windows. `None` when the snapshot has no windows — the unavailable state,
/// never a fabricated 0.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeConstraint<'a> {
    pub kind: ClaudeKind,
    pub percent: f64,
    pub resets_at: Option<i64>,
    pub model: Option<&'a str>,
}

pub fn claude_constraint(snapshot: &ClaudeSnapshot) -> Option<ClaudeConstraint<'_>> {
    let mut windows = Vec::with_capacity(2 + snapshot.week_model.len());
    if let Some(session) = &snapshot.session {
        windows.push(ClaudeConstraint {
            kind: ClaudeKind::Session,
            percent: session.percent,
            resets_at: session.resets_at,
            model: None,
        });
    }
    if let Some(week) = &snapshot.week {
        windows.push(ClaudeConstraint {
            kind: ClaudeKind::Week,
            percent: week.percent,
            resets_at: week.resets_at,
            model: None,
        });
    }
    for entry in &snapshot.week_model {
        windows.push(ClaudeConstraint {
            kind: ClaudeKind::WeekModel,
            percent: entry.window.percent,
            resets_at: entry.window.resets_at,
            model: Some(entry.model.as_str()),
        });
    }
    let mut constraint: Option<ClaudeConstraint<'_>> = None;
    for window in windows {
        if constraint
            .as_ref()
            .is_none_or(|c| window.percent > c.percent)
        {
            constraint = Some(window);
        }
    }
    constraint
}

fn threshold_state(percent: f64, opts: &Options) -> State {
    if percent >= 100.0 {
        State::LimitHit
    } else if percent >= opts.critical_at {
        State::Critical
    } else if percent >= opts.warning_at {
        State::Warning
    } else {
        State::Normal
    }
}

/// Codex's provider-level constraint: the highest window only inside the
/// main included-usage bucket. A separately metered model such as Spark
/// remains visible in the menu but cannot make ordinary Codex look blocked.
pub fn codex_constraint(snapshot: &CodexSnapshot) -> Option<&CodexWindow> {
    let main_id = codex_main_limit_id(snapshot)?;
    snapshot
        .windows
        .iter()
        .filter(|w| w.limit_id == main_id)
        .fold(None, |best: Option<&CodexWindow>, w| match best {
            Some(b) if w.percent <= b.percent => Some(b),
            _ => Some(w),
        })
}

fn codex_main_limit_id(snapshot: &CodexSnapshot) -> Option<&str> {
    snapshot.main_limit_id.as_deref().or_else(|| {
        snapshot
            .windows
            .iter()
            .find(|w| w.limit_id == "codex")
            .or_else(|| snapshot.windows.iter().find(|w| w.limit_name.is_none()))
            .map(|w| w.limit_id.as_str())
    })
}

fn codex_access_unknown(snapshot: &CodexSnapshot) -> bool {
    snapshot.access == Access::Unknown
}

fn codex_reached_description(snapshot: &CodexSnapshot, constraint: &CodexWindow) -> &'static str {
    match constraint.reached_type.as_deref() {
        None if snapshot.access == Access::Denied => "included usage unavailable",
        Some("workspace_owner_credits_depleted" | "workspace_member_credits_depleted") => {
            "workspace credits depleted"
        }
        Some("workspace_owner_usage_limit_reached" | "workspace_member_usage_limit_reached") => {
            "workspace usage limit reached"
        }
        _ => "included usage limit reached",
    }
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderItem {
    pub name: &'static str,
    pub mark: Mark,
    /// Fill percent for the meter, or `None` for the slashed unavailable meter.
    pub percent: Option<f64>,
    pub state: State,
    /// The color state of the meter: stale keeps the threshold color.
    pub meter_state: State,
    pub opacity: f32,
    /// §8: the full story, independent of what the meter can show.
    pub accessible_name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IndicatorModel {
    pub items: Vec<ProviderItem>,
    pub accessible_name: String,
}

/// ", resets in 2 h 15 m (17:00)" — the §4.3 reset row recast as a clause.
fn reset_clause(resets_at: Option<i64>, now: i64, clock24: bool) -> String {
    match resets_at {
        None => String::new(),
        Some(at) => {
            let row = format_reset_row(at, now, clock24);
            format!(", {}", lowercase_first(&row))
        }
    }
}

fn lowercase_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn claude_item(snapshot: Option<&ClaudeSnapshot>, now: i64, opts: &Options) -> ProviderItem {
    let constraint = snapshot.and_then(claude_constraint);
    let (Some(snapshot), Some(constraint)) = (snapshot, constraint) else {
        return unavailable_item("Claude", Mark::Claude, "Claude usage data unavailable");
    };
    let threshold = threshold_state(constraint.percent, opts);
    let stale = now - snapshot.fetched_at > opts.stale_after_ms;
    let state = if stale { State::Stale } else { threshold };
    let accessible_name = if stale {
        format!(
            "Claude usage: {} percent used, data is {} old",
            constraint.percent.round() as i64,
            format_age(now - snapshot.fetched_at)
        )
    } else if state == State::LimitHit {
        format!(
            "Claude usage limit reached{}",
            reset_clause(constraint.resetsat(), now, opts.clock24)
        )
    } else {
        format!(
            "Claude usage: {} percent used{}",
            constraint.percent.round() as i64,
            reset_clause(constraint.resetsat(), now, opts.clock24)
        )
    };
    ProviderItem {
        name: "Claude",
        mark: Mark::Claude,
        percent: Some(constraint.percent),
        state,
        meter_state: threshold,
        opacity: if stale { DIM_OPACITY } else { 1.0 },
        accessible_name,
    }
}

impl ClaudeConstraint<'_> {
    fn resetsat(&self) -> Option<i64> {
        self.resets_at
    }
}

fn codex_item(snapshot: Option<&CodexSnapshot>, now: i64, opts: &Options) -> ProviderItem {
    let Some(snapshot) = snapshot else {
        return unavailable_item("Codex", Mark::Codex, "Codex usage data unavailable");
    };
    if codex_access_unknown(snapshot) {
        return unavailable_item("Codex", Mark::Codex, "Codex access status unavailable");
    }
    let Some(constraint) = codex_constraint(snapshot) else {
        return unavailable_item("Codex", Mark::Codex, "Codex usage data unavailable");
    };
    let authoritative_reached =
        snapshot.access == Access::Denied || constraint.reached_type.is_some();
    let threshold = if authoritative_reached {
        State::LimitHit
    } else {
        threshold_state(constraint.percent, opts)
    };
    let stale = now - snapshot.fetched_at > opts.stale_after_ms;
    let state = if stale { State::Stale } else { threshold };
    let accessible_name = if stale {
        format!(
            "Codex usage: {} percent used, data is {} old",
            constraint.percent.round() as i64,
            format_age(now - snapshot.fetched_at)
        )
    } else if state == State::LimitHit {
        let reset_is_authoritative = match constraint.reached_type.as_deref() {
            Some("rate_limit_reached") => true,
            None => snapshot.access != Access::Denied,
            Some(_) => false,
        };
        let mut name = format!("Codex {}", codex_reached_description(snapshot, constraint));
        if reset_is_authoritative {
            name.push_str(&reset_clause(constraint.resets_at, now, opts.clock24));
        }
        name
    } else {
        format!(
            "Codex usage: {} percent used{}",
            constraint.percent.round() as i64,
            reset_clause(constraint.resets_at, now, opts.clock24)
        )
    };
    ProviderItem {
        name: "Codex",
        mark: Mark::Codex,
        percent: Some(constraint.percent),
        state,
        meter_state: threshold,
        opacity: if stale { DIM_OPACITY } else { 1.0 },
        accessible_name,
    }
}

fn unavailable_item(name: &'static str, mark: Mark, accessible_name: &str) -> ProviderItem {
    ProviderItem {
        name,
        mark,
        percent: None,
        state: State::Unavailable,
        meter_state: State::Unavailable,
        opacity: DIM_OPACITY,
        accessible_name: accessible_name.to_owned(),
    }
}

pub fn indicator_model(snapshot: Option<&Snapshot>, now: i64, opts: &Options) -> IndicatorModel {
    let items = vec![
        claude_item(snapshot.map(|s| &s.claude), now, opts),
        codex_item(snapshot.map(|s| &s.codex), now, opts),
    ];
    let accessible_name = items
        .iter()
        .map(|item| item.accessible_name.as_str())
        .collect::<Vec<_>>()
        .join("; ");
    IndicatorModel {
        items,
        accessible_name,
    }
}

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------

const MAX_DYNAMIC_LABEL_CHARS: usize = 24;

/// Dynamic labels are capped at 24 characters (visual ellipsizing in the
/// widget is the second line of defense) so data can never widen the popup.
fn bounded_label(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= MAX_DYNAMIC_LABEL_CHARS {
        return value.to_owned();
    }
    let mut out: String = chars[..MAX_DYNAMIC_LABEL_CHARS - 1].iter().collect();
    out.push('…');
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    /// Bounded Codex bucket heading on its first row, else `None`.
    pub bucket_title: Option<String>,
    pub title: String,
    pub percent: f64,
    pub percent_text: String,
    /// This window's own percent against the thresholds — each bar colors
    /// independently.
    pub bar_state: State,
    /// §4.3 reset row, or `None` for no row (never a fabricated countdown).
    pub reset_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub title: &'static str,
    pub mark: Mark,
    pub sections: Vec<Section>,
    /// Quiet read-only metadata (Codex earned resets), once below the group.
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Notice {
    pub headline: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Footer {
    pub freshness_text: String,
    pub stale: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MenuModel {
    /// §4.5 limit-hit promotion lines, the menu's first block.
    pub promoted: Vec<String>,
    /// §4.5 unavailable block: plain-language sentence, then the action.
    pub notice: Option<Notice>,
    pub groups: Vec<Group>,
    pub footer: Footer,
}

fn bar_state(percent: f64, opts: &Options) -> State {
    if percent >= opts.critical_at {
        State::Critical
    } else if percent >= opts.warning_at {
        State::Warning
    } else {
        State::Normal
    }
}

fn claude_section(
    title: String,
    percent: f64,
    resets_at: Option<i64>,
    now: i64,
    opts: &Options,
) -> Section {
    Section {
        bucket_title: None,
        title,
        percent,
        percent_text: format_percent(percent),
        bar_state: bar_state(percent, opts),
        reset_text: resets_at.map(|at| format_reset_row(at, now, opts.clock24)),
    }
}

fn duration_label(minutes: Option<f64>, slot: crate::codex::Slot) -> String {
    let Some(minutes) = minutes else {
        return match slot {
            crate::codex::Slot::Primary => "Current window".to_owned(),
            crate::codex::Slot::Secondary => "Additional window".to_owned(),
        };
    };
    let whole = minutes.round() as i64;
    if (minutes - whole as f64).abs() < f64::EPSILON && whole % 1440 == 0 {
        let days = whole / 1440;
        format!("{days} {}", if days == 1 { "day" } else { "days" })
    } else if (minutes - whole as f64).abs() < f64::EPSILON && whole % 60 == 0 {
        let hours = whole / 60;
        format!("{hours} {}", if hours == 1 { "hour" } else { "hours" })
    } else {
        format!("{minutes} min")
    }
}

fn codex_bucket_name(window: &CodexWindow, main_limit_id: Option<&str>) -> String {
    if Some(window.limit_id.as_str()) == main_limit_id {
        return "Included usage".to_owned();
    }
    match &window.limit_name {
        None => "Other usage".to_owned(),
        Some(name) => bounded_label(name),
    }
}

/// Group windows by bucket in arrival order (the parser already put the main
/// bucket first).
fn codex_buckets(snapshot: &CodexSnapshot) -> Vec<Vec<&CodexWindow>> {
    let mut buckets: Vec<Vec<&CodexWindow>> = Vec::new();
    for window in &snapshot.windows {
        match buckets
            .iter_mut()
            .find(|b| b[0].limit_id == window.limit_id)
        {
            Some(bucket) => bucket.push(window),
            None => buckets.push(vec![window]),
        }
    }
    buckets
}

fn codex_sections(snapshot: &CodexSnapshot, now: i64, opts: &Options) -> Vec<Section> {
    let main_limit_id = codex_main_limit_id(snapshot);
    let mut sections = Vec::new();
    for bucket in codex_buckets(snapshot) {
        let name = codex_bucket_name(bucket[0], main_limit_id);
        let denied =
            Some(bucket[0].limit_id.as_str()) == main_limit_id && snapshot.access == Access::Denied;
        for (index, window) in bucket.iter().enumerate() {
            sections.push(Section {
                bucket_title: (index == 0).then(|| name.clone()),
                title: duration_label(window.duration_mins, window.slot),
                percent: window.percent,
                percent_text: format_percent(window.percent),
                bar_state: if denied || window.reached_type.is_some() {
                    State::Critical
                } else {
                    bar_state(window.percent, opts)
                },
                reset_text: window
                    .resets_at
                    .map(|at| format_reset_row(at, now, opts.clock24)),
            });
        }
    }
    sections
}

fn codex_reset_credit_text(snapshot: &CodexSnapshot) -> Option<String> {
    match snapshot.reset_credits_available {
        Some(count) if count > 0 => Some(format!(
            "{count} rate-limit {} available",
            if count == 1 { "reset" } else { "resets" }
        )),
        _ => None,
    }
}

fn codex_promotion_lines(snapshot: &CodexSnapshot, now: i64, clock24: bool) -> Vec<String> {
    let main_limit_id = codex_main_limit_id(snapshot);
    let mut lines = Vec::new();
    for bucket in codex_buckets(snapshot) {
        let first = bucket[0];
        let reached_type = bucket.iter().find_map(|w| w.reached_type.as_deref());
        let reached_window = bucket
            .iter()
            .find(|w| w.percent >= 100.0)
            .copied()
            .or_else(|| {
                bucket
                    .iter()
                    .copied()
                    .fold(None, |best: Option<&CodexWindow>, w| match best {
                        Some(b) if w.percent <= b.percent => Some(b),
                        _ => Some(w),
                    })
            });
        let ordinary_denied =
            Some(first.limit_id.as_str()) == main_limit_id && snapshot.access == Access::Denied;
        if reached_type.is_none() && !ordinary_denied && !bucket.iter().any(|w| w.percent >= 100.0)
        {
            continue;
        }
        let mut text = match reached_type {
            Some("workspace_owner_credits_depleted" | "workspace_member_credits_depleted") => {
                "Codex workspace credits depleted".to_owned()
            }
            Some(
                "workspace_owner_usage_limit_reached" | "workspace_member_usage_limit_reached",
            ) => "Codex workspace usage limit reached".to_owned(),
            None if ordinary_denied => "Codex included usage unavailable".to_owned(),
            _ => {
                let name = if Some(first.limit_id.as_str()) == main_limit_id {
                    "Codex included usage".to_owned()
                } else {
                    codex_bucket_name(first, main_limit_id)
                };
                format!("{name} limit reached")
            }
        };
        let reset_is_authoritative = reached_type == Some("rate_limit_reached")
            || (reached_type.is_none() && !ordinary_denied);
        if reset_is_authoritative && let Some(at) = reached_window.and_then(|w| w.resets_at) {
            text.push_str(&format!(
                " — {}",
                lowercase_first(&format_reset_row(at, now, clock24))
            ));
        }
        lines.push(text);
    }
    lines
}

fn claude_promoted_line(constraint: &ClaudeConstraint<'_>, now: i64, clock24: bool) -> String {
    let name = match constraint.kind {
        ClaudeKind::Session => "session".to_owned(),
        ClaudeKind::Week => "weekly".to_owned(),
        ClaudeKind::WeekModel => format!("weekly {}", constraint.model.unwrap_or("")),
    };
    match constraint.resets_at {
        None => format!("Claude {name} limit reached"),
        Some(at) => format!(
            "Claude {name} limit reached — {}",
            lowercase_first(&format_reset_row(at, now, clock24))
        ),
    }
}

/// §4.5 wording table. Only `NotInstalled` (and the Codex unknown-access
/// state) are distinguishable to the user; everything else gets the generic
/// block, so no raw error string can surface by construction.
fn provider_notice(name: &str, error: Option<ProviderError>, access_unknown: bool) -> Notice {
    if error == Some(ProviderError::NotInstalled) {
        return Notice {
            headline: format!("{name} was not found on this system."),
            detail: format!("Install {name}, then refresh."),
        };
    }
    if access_unknown {
        return Notice {
            headline: "Codex access status is unavailable.".to_owned(),
            detail: "Refresh Codex usage data to check again.".to_owned(),
        };
    }
    Notice {
        headline: format!("Can't read {name} usage data."),
        detail: format!("Open {name} and sign in, then refresh."),
    }
}

fn freshness_part(
    name: &str,
    fetched_at: Option<i64>,
    usable: bool,
    failed: bool,
    now: i64,
    opts: &Options,
) -> String {
    let (true, Some(fetched_at)) = (usable, fetched_at) else {
        return format!("{name} unavailable");
    };
    let age = (now - fetched_at).max(0);
    if age > opts.stale_after_ms {
        return format!(
            "{name} {} old{}",
            format_age(age),
            if failed { " (failed)" } else { "" }
        );
    }
    if age < 30_000 {
        return format!("{name} now");
    }
    format!("{name} {} min", round_minutes(age))
}

pub fn menu_model(snapshot: Option<&Snapshot>, now: i64, opts: &Options) -> MenuModel {
    let claude = snapshot.map(|s| &s.claude);
    let codex = snapshot.map(|s| &s.codex);

    let mut claude_sections = Vec::new();
    if let Some(claude) = claude {
        if let Some(session) = &claude.session {
            claude_sections.push(claude_section(
                "Session · 5 hours".to_owned(),
                session.percent,
                session.resets_at,
                now,
                opts,
            ));
        }
        if let Some(week) = &claude.week {
            claude_sections.push(claude_section(
                "All models · 7 days".to_owned(),
                week.percent,
                week.resets_at,
                now,
                opts,
            ));
        }
        for entry in &claude.week_model {
            claude_sections.push(claude_section(
                format!("{} · 7 days", bounded_label(&entry.model)),
                entry.window.percent,
                entry.window.resets_at,
                now,
                opts,
            ));
        }
    }
    let codex_sections = codex
        .map(|c| codex_sections(c, now, opts))
        .unwrap_or_default();
    let groups: Vec<Group> = [
        Group {
            title: "Claude",
            mark: Mark::Claude,
            sections: claude_sections,
            note: None,
        },
        Group {
            title: "Codex",
            mark: Mark::Codex,
            sections: codex_sections,
            note: codex.and_then(codex_reset_credit_text),
        },
    ]
    .into_iter()
    .filter(|group| !group.sections.is_empty() || group.note.is_some())
    .collect();

    let claude_constraint = claude.and_then(claude_constraint);
    let codex_access_unknown = codex.is_some_and(codex_access_unknown);
    let codex_constraint = codex.and_then(codex_constraint);
    let claude_usable = claude_constraint.is_some();
    let codex_usable = codex_constraint.is_some() && !codex_access_unknown;

    let notice = match (claude_usable, codex_usable) {
        (true, true) => None,
        (false, true) => Some(provider_notice(
            "Claude Code",
            claude.and_then(|c| c.error),
            false,
        )),
        (true, false) => Some(provider_notice(
            "Codex",
            codex.and_then(|c| c.error),
            codex_access_unknown,
        )),
        (false, false) => Some(Notice {
            headline: "Claude and Codex usage data are unavailable.".to_owned(),
            detail: "Install or sign in to the provider clients, then refresh.".to_owned(),
        }),
    };

    let mut promoted = Vec::new();
    if let (Some(claude), Some(constraint)) = (claude, &claude_constraint)
        && now - claude.fetched_at <= opts.stale_after_ms
        && constraint.percent >= 100.0
    {
        promoted.push(claude_promoted_line(constraint, now, opts.clock24));
    }
    if let Some(codex) = codex
        && !codex.windows.is_empty()
        && now - codex.fetched_at <= opts.stale_after_ms
    {
        promoted.extend(codex_promotion_lines(codex, now, opts.clock24));
    }

    let freshness_text = format!(
        "{} · {}",
        freshness_part(
            "Claude",
            claude.map(|c| c.fetched_at),
            claude_usable,
            opts.last_refresh_failed.claude,
            now,
            opts
        ),
        freshness_part(
            "Codex",
            codex.map(|c| c.fetched_at),
            codex_usable,
            opts.last_refresh_failed.codex,
            now,
            opts
        ),
    );
    let stale = (claude_usable && claude.is_some_and(|c| now - c.fetched_at > opts.stale_after_ms))
        || (codex_usable && codex.is_some_and(|c| now - c.fetched_at > opts.stale_after_ms));

    MenuModel {
        promoted,
        notice,
        groups,
        footer: Footer {
            freshness_text,
            stale,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::{ModelWindow, UsageWindow};
    use crate::codex::{Slot, parse_codex_rate_limits};

    const CACHE: &str = include_str!("../tests/fixtures/cached-usage-utilization.json");
    const CODEX: &str = include_str!("../tests/fixtures/codex-rate-limits-result.json");

    fn claude_fixture() -> ClaudeSnapshot {
        crate::claude::parse_snapshot(
            format!(r#"{{"cachedUsageUtilization": {CACHE}}}"#).as_bytes(),
            0,
        )
    }

    fn codex_fixture(now: i64) -> CodexSnapshot {
        parse_codex_rate_limits(&serde_json::from_str(CODEX).unwrap(), now)
    }

    fn snapshot(now: i64) -> Snapshot {
        let mut claude = claude_fixture();
        claude.fetched_at = now;
        Snapshot {
            claude,
            codex: codex_fixture(now),
        }
    }

    #[test]
    fn countdown_and_age_wording() {
        assert_eq!(format_countdown(59_999), "<1 min");
        assert_eq!(format_countdown(12 * MINUTE_MS + 59_000), "12 m");
        assert_eq!(format_countdown(HOUR_MS), "1 h");
        assert_eq!(format_countdown(2 * HOUR_MS + 15 * MINUTE_MS), "2 h 15 m");
        assert_eq!(format_age(25 * MINUTE_MS), "25 min");
        assert_eq!(format_age(HOUR_MS + 5 * MINUTE_MS), "1 h 5 min");
        assert_eq!(format_percent(66.5), "67%");
    }

    #[test]
    fn reset_rows_pair_relative_and_absolute_within_a_day() {
        let now = 1_784_959_900_803;
        let row = format_reset_row(now + 2 * HOUR_MS + 15 * MINUTE_MS, now, true);
        assert!(row.starts_with("Resets in 2 h 15 m ("), "{row}");
        assert!(row.ends_with(')'));
        let row12 = format_reset_row(now + 2 * HOUR_MS + 15 * MINUTE_MS, now, false);
        assert!(row12.contains(" AM)") || row12.contains(" PM)"), "{row12}");
        // Exactly 24 h still counts down; beyond it the date form takes over.
        assert!(format_reset_row(now + DAY_MS, now, true).starts_with("Resets in 24 h ("));
        let beyond = format_reset_row(now + DAY_MS + 1, now, true);
        assert!(
            beyond.starts_with("Resets ") && !beyond.contains("in "),
            "{beyond}"
        );
        assert_eq!(beyond.matches(", ").count(), 1);
    }

    #[test]
    fn claude_constraint_is_the_highest_window_with_stable_ties() {
        let claude = claude_fixture();
        let constraint = claude_constraint(&claude).unwrap();
        assert_eq!(constraint.kind, ClaudeKind::Week);
        assert_eq!(constraint.percent, 34.0);
        let tie = ClaudeSnapshot {
            fetched_at: 1,
            session: Some(UsageWindow {
                percent: 50.0,
                resets_at: None,
            }),
            week: Some(UsageWindow {
                percent: 50.0,
                resets_at: None,
            }),
            week_model: vec![ModelWindow {
                model: "Fable".into(),
                window: UsageWindow {
                    percent: 50.0,
                    resets_at: None,
                },
            }],
            error: None,
        };
        assert_eq!(claude_constraint(&tie).unwrap().kind, ClaudeKind::Session);
        assert_eq!(
            claude_constraint(&ClaudeSnapshot::failed(1, ProviderError::NotInstalled)),
            None
        );
    }

    #[test]
    fn codex_meter_follows_only_the_main_bucket() {
        let codex = codex_fixture(0);
        assert_eq!(codex_constraint(&codex).unwrap().percent, 31.0);
        let mut spark_blocked = codex.clone();
        for window in &mut spark_blocked.windows {
            if window.limit_id == "codex_bengalfox" {
                window.percent = 100.0;
                window.reached_type = Some("rate_limit_reached".into());
            }
        }
        let model = indicator_model(
            Some(&Snapshot {
                claude: claude_fixture(),
                codex: spark_blocked.clone(),
            }),
            0,
            &Options::default(),
        );
        assert_eq!(model.items[1].state, State::Normal);
        assert_eq!(model.items[1].percent, Some(31.0));
        // ...but the menu still promotes the model bucket's own reached state.
        let menu = menu_model(
            Some(&Snapshot {
                claude: claude_fixture(),
                codex: spark_blocked,
            }),
            0,
            &Options::default(),
        );
        assert_eq!(menu.promoted.len(), 1);
        assert!(
            menu.promoted[0].starts_with("GPT-5.3-Codex-Spark limit reached — resets"),
            "{:?}",
            menu.promoted
        );
    }

    #[test]
    fn indicator_states_by_threshold_staleness_and_availability() {
        let now = 1_000_000;
        let opts = Options::default();
        let model = indicator_model(Some(&snapshot(now)), now, &opts);
        assert_eq!(model.items[0].state, State::Normal);
        assert_eq!(model.items[0].percent, Some(34.0));
        assert_eq!(model.items[0].opacity, 1.0);
        assert!(
            model.items[0]
                .accessible_name
                .starts_with("Claude usage: 34 percent used, resets ")
        );
        assert!(
            model
                .accessible_name
                .contains("; Codex usage: 31 percent used")
        );

        let stale = indicator_model(Some(&snapshot(now)), now + opts.stale_after_ms + 1, &opts);
        assert_eq!(stale.items[0].state, State::Stale);
        assert_eq!(stale.items[0].meter_state, State::Normal);
        assert_eq!(stale.items[0].opacity, DIM_OPACITY);
        assert!(
            stale.items[0]
                .accessible_name
                .ends_with("data is 3 min old")
        );

        let mut warning = snapshot(now);
        warning.claude.week.as_mut().unwrap().percent = 80.0;
        assert_eq!(
            indicator_model(Some(&warning), now, &opts).items[0].state,
            State::Warning
        );
        warning.claude.week.as_mut().unwrap().percent = 95.0;
        assert_eq!(
            indicator_model(Some(&warning), now, &opts).items[0].state,
            State::Critical
        );
        warning.claude.week.as_mut().unwrap().percent = 100.0;
        let hit = indicator_model(Some(&warning), now, &opts);
        assert_eq!(hit.items[0].state, State::LimitHit);
        assert!(
            hit.items[0]
                .accessible_name
                .starts_with("Claude usage limit reached, resets")
        );

        let none = indicator_model(None, now, &opts);
        assert_eq!(none.items[0].percent, None);
        assert_eq!(none.items[0].state, State::Unavailable);
        assert_eq!(none.items[1].state, State::Unavailable);
        assert_eq!(
            none.accessible_name,
            "Claude usage data unavailable; Codex usage data unavailable"
        );

        let mut unknown = snapshot(now);
        unknown.codex.access = Access::Unknown;
        let model = indicator_model(Some(&unknown), now, &opts);
        assert_eq!(model.items[1].state, State::Unavailable);
        assert_eq!(
            model.items[1].accessible_name,
            "Codex access status unavailable"
        );

        let mut denied = snapshot(now);
        denied.codex.access = Access::Denied;
        let model = indicator_model(Some(&denied), now, &opts);
        assert_eq!(model.items[1].state, State::LimitHit);
        assert_eq!(model.items[1].percent, Some(31.0));
        assert_eq!(
            model.items[1].accessible_name,
            "Codex included usage unavailable"
        );
    }

    #[test]
    fn menu_groups_windows_under_one_provider_heading_each() {
        let now = 1_000_000;
        let menu = menu_model(Some(&snapshot(now)), now, &Options::default());
        assert_eq!(menu.notice, None);
        assert!(menu.promoted.is_empty());
        assert_eq!(menu.groups.len(), 2);
        let claude = &menu.groups[0];
        assert_eq!(claude.title, "Claude");
        let titles: Vec<&str> = claude.sections.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(
            titles,
            ["Session · 5 hours", "All models · 7 days", "Fable · 7 days"]
        );
        assert_eq!(claude.sections[0].percent_text, "27%");
        assert!(claude.sections.iter().all(|s| s.reset_text.is_some()));
        assert!(claude.sections.iter().all(|s| s.bucket_title.is_none()));

        let codex = &menu.groups[1];
        assert_eq!(codex.note.as_deref(), Some("2 rate-limit resets available"));
        let rows: Vec<(Option<&str>, &str, &str)> = codex
            .sections
            .iter()
            .map(|s| {
                (
                    s.bucket_title.as_deref(),
                    s.title.as_str(),
                    s.percent_text.as_str(),
                )
            })
            .collect();
        assert_eq!(
            rows,
            [
                (Some("Included usage"), "7 days", "31%"),
                (Some("GPT-5.3-Codex-Spark"), "5 hours", "12%"),
                (None, "7 days", "18%"),
            ]
        );
        assert_eq!(menu.footer.freshness_text, "Claude now · Codex now");
        assert!(!menu.footer.stale);
    }

    #[test]
    fn long_model_names_are_bounded() {
        let mut snap = snapshot(0);
        snap.claude.week_model[0].model = "A".repeat(40);
        let menu = menu_model(Some(&snap), 0, &Options::default());
        let title = &menu.groups[0].sections[2].title;
        assert_eq!(title.chars().count(), 24 + " · 7 days".chars().count());
        assert!(title.contains('…'));
        assert_eq!(duration_label(Some(300.0), Slot::Primary), "5 hours");
        assert_eq!(duration_label(Some(60.0), Slot::Primary), "1 hour");
        assert_eq!(duration_label(Some(90.0), Slot::Primary), "90 min");
        assert_eq!(duration_label(None, Slot::Secondary), "Additional window");
    }

    #[test]
    fn menu_notices_and_footer_in_degraded_states() {
        let now = 1_000_000;
        let opts = Options::default();
        let mut snap = snapshot(now);
        snap.codex = CodexSnapshot::failed(now, ProviderError::NotInstalled, None);
        let menu = menu_model(Some(&snap), now, &opts);
        assert_eq!(menu.groups.len(), 1);
        let notice = menu.notice.unwrap();
        assert_eq!(notice.headline, "Codex was not found on this system.");
        assert_eq!(notice.detail, "Install Codex, then refresh.");
        assert_eq!(menu.footer.freshness_text, "Claude now · Codex unavailable");

        let both = menu_model(None, now, &opts);
        assert!(both.groups.is_empty());
        assert_eq!(
            both.notice.unwrap().headline,
            "Claude and Codex usage data are unavailable."
        );
        assert_eq!(
            both.footer.freshness_text,
            "Claude unavailable · Codex unavailable"
        );

        let mut signed_out = snapshot(now);
        signed_out.claude = ClaudeSnapshot::failed(now, ProviderError::NotAuthenticated);
        let notice = menu_model(Some(&signed_out), now, &opts).notice.unwrap();
        assert_eq!(notice.headline, "Can't read Claude Code usage data.");
        assert_eq!(notice.detail, "Open Claude Code and sign in, then refresh.");

        let failed = Options {
            last_refresh_failed: RefreshFailed {
                claude: true,
                codex: false,
            },
            ..opts
        };
        let old = menu_model(Some(&snapshot(now)), now + 25 * MINUTE_MS, &failed);
        assert_eq!(
            old.footer.freshness_text,
            "Claude 25 min old (failed) · Codex 25 min old"
        );
        assert!(old.footer.stale);
        let recent = menu_model(Some(&snapshot(now)), now + 2 * MINUTE_MS, &opts);
        assert_eq!(recent.footer.freshness_text, "Claude 2 min · Codex 2 min");
    }

    #[test]
    fn limit_hit_promotes_the_reset_row_unless_stale() {
        let now = 1_000_000;
        let opts = Options::default();
        let mut hit = snapshot(now);
        hit.claude.session = Some(UsageWindow {
            percent: 100.0,
            resets_at: Some(now + 72 * MINUTE_MS),
        });
        let menu = menu_model(Some(&hit), now, &opts);
        assert_eq!(menu.promoted.len(), 1);
        assert!(
            menu.promoted[0].starts_with("Claude session limit reached — resets in 1 h 12 m ("),
            "{:?}",
            menu.promoted
        );
        assert_eq!(menu.groups[0].sections[0].bar_state, State::Critical);
        let stale = menu_model(Some(&hit), now + opts.stale_after_ms + 1, &opts);
        assert!(stale.promoted.is_empty());

        let mut denied = snapshot(now);
        denied.codex.access = Access::Denied;
        let menu = menu_model(Some(&denied), now, &opts);
        assert_eq!(menu.promoted, ["Codex included usage unavailable"]);
        assert_eq!(menu.groups[1].sections[0].bar_state, State::Critical);
        assert_eq!(menu.groups[1].sections[1].bar_state, State::Normal);
    }
}
