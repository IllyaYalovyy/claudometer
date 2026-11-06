//! Provider reads are independent and concurrent. An unavailable provider
//! never hides a healthy snapshot from the other provider.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use crate::claude::{ClaudeConfig, ClaudeSnapshot, ClaudeSource};
use crate::codex::{CodexConfig, CodexSnapshot, CodexSource};

/// The combined snapshot the render models consume.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub claude: ClaudeSnapshot,
    pub codex: CodexSnapshot,
}

/// Whether the most recent refresh of each provider actually failed (#16).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RefreshFailed {
    pub claude: bool,
    pub codex: bool,
}

/// Everything one fetch cycle hands back to the UI thread.
#[derive(Debug, Clone, PartialEq)]
pub struct FetchOutput {
    pub snapshot: Snapshot,
    pub last_refresh_failed: RefreshFailed,
    /// Current value of the G1 tripwire latch, so the applet can persist a
    /// trip that happened during this fetch.
    pub claude_refresh_disabled: bool,
}

pub struct MultiSource {
    claude: ClaudeSource,
    codex: CodexSource,
}

impl MultiSource {
    pub fn new(refresh_disabled: Arc<AtomicBool>) -> Self {
        Self {
            claude: ClaudeSource::new(ClaudeConfig::default(), refresh_disabled),
            codex: CodexSource::new(CodexConfig::default()),
        }
    }

    pub async fn fetch(&mut self, now: i64, manual: bool) -> FetchOutput {
        let (claude, codex) = tokio::join!(
            self.claude.fetch(now, manual),
            self.codex.fetch(now, manual)
        );
        FetchOutput {
            snapshot: Snapshot { claude, codex },
            last_refresh_failed: RefreshFailed {
                claude: self.claude.last_refresh_failed(),
                codex: self.codex.last_refresh_failed(),
            },
            claude_refresh_disabled: self.claude.refresh_disabled(),
        }
    }
}

impl Snapshot {
    /// Whether either provider's fetch produced an error snapshot — the
    /// scheduler's backoff trigger.
    pub fn has_error(&self) -> bool {
        self.claude.is_error() || self.codex.is_error()
    }
}
