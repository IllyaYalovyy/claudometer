//! Claudometer for the COSMIC™ desktop: a panel applet showing Claude Code
//! and Codex usage limits without ever starting a model turn to check.
//!
//! This is a port of the GNOME Shell extension in `../src`. The module split
//! mirrors `src/lib/` there: the parsers, data sources, scheduling policy and
//! render models are pure and unit-tested; `window.rs` only maps the models
//! onto libcosmic widgets.

mod claude;
mod codex;
mod config;
mod marks;
mod model;
mod scheduler;
mod source;
mod window;

pub use claude::{ClaudeSnapshot, parse_snapshot};
pub use codex::{CodexSnapshot, parse_codex_rate_limits};
pub use config::Settings;
pub use source::Snapshot;

pub fn run() -> cosmic::iced::Result {
    cosmic::applet::run::<window::Window>(())
}

/// Wall-clock time as epoch milliseconds, the unit every snapshot and reset
/// time in this crate uses.
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
