//! Refresh policy as a pure state machine. The timer and request driver
//! lives in `window.rs`.

/// Exponential backoff on failure, 1 → 2 → 5 min cap. Consecutive
/// failure N waits `LADDER[N-1]` (the last rung past the end).
pub const BACKOFF_LADDER_SEC: [u32; 3] = [60, 120, 300];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backoff {
    pub base_sec: u32,
    pub failures: u32,
    pub delay_sec: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// A usable snapshot landed.
    Success,
    /// An error snapshot landed.
    Failure,
    /// A user-initiated refresh: resets backoff before the outcome is known.
    Manual,
}

impl Backoff {
    pub fn initial(base_sec: u32) -> Self {
        Self {
            base_sec,
            failures: 0,
            delay_sec: base_sec,
        }
    }

    fn rung(failures: u32) -> u32 {
        let index = (failures.min(BACKOFF_LADDER_SEC.len() as u32).max(1) - 1) as usize;
        BACKOFF_LADDER_SEC[index]
    }

    /// Backing off only ever slows down: a rung is never allowed below the
    /// configured base interval.
    pub fn next(self, event: Event) -> Self {
        match event {
            Event::Success | Event::Manual => Self {
                failures: 0,
                delay_sec: self.base_sec,
                ..self
            },
            Event::Failure => {
                let failures = self.failures + 1;
                Self {
                    failures,
                    delay_sec: self.base_sec.max(Self::rung(failures)),
                    ..self
                }
            }
        }
    }

    /// Live cadence change: keep the failure count, recompute the delay for
    /// the new base with the same floor rule.
    pub fn rebased(self, base_sec: u32) -> Self {
        if self.failures == 0 {
            return Self::initial(base_sec);
        }
        Self {
            base_sec,
            failures: self.failures,
            delay_sec: base_sec.max(Self::rung(self.failures)),
        }
    }
}

/// Menu-open policy (§5/§6): refresh only when the last completed fetch is
/// strictly older than `max_age_ms` (or never happened). `fetched_at` is the
/// driver's own completion time, not the payload's timestamp — the CLI's
/// cache-write throttle makes the payload routinely older than any
/// menu-open threshold.
pub fn needs_refresh(fetched_at: Option<i64>, now: i64, max_age_ms: i64) -> bool {
    match fetched_at {
        None => true,
        Some(at) => now - at > max_age_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ladder_climbs_and_resets() {
        let s = Backoff::initial(30);
        assert_eq!(s.delay_sec, 30);
        let s = s.next(Event::Failure);
        assert_eq!((s.failures, s.delay_sec), (1, 60));
        let s = s.next(Event::Failure);
        assert_eq!((s.failures, s.delay_sec), (2, 120));
        let s = s.next(Event::Failure);
        assert_eq!((s.failures, s.delay_sec), (3, 300));
        let s = s.next(Event::Failure);
        assert_eq!((s.failures, s.delay_sec), (4, 300));
        let s = s.next(Event::Success);
        assert_eq!((s.failures, s.delay_sec), (0, 30));
        let s = s.next(Event::Failure).next(Event::Manual);
        assert_eq!((s.failures, s.delay_sec), (0, 30));
    }

    #[test]
    fn backoff_never_speeds_up_below_the_base() {
        let s = Backoff::initial(600).next(Event::Failure);
        assert_eq!(s.delay_sec, 600);
        let s = s.rebased(60);
        assert_eq!((s.failures, s.delay_sec), (1, 60));
        let s = Backoff::initial(60).rebased(300);
        assert_eq!(s, Backoff::initial(300));
    }

    #[test]
    fn menu_open_refresh_keys_on_driver_age() {
        assert!(needs_refresh(None, 100, 15_000));
        assert!(!needs_refresh(Some(100), 15_100, 15_000));
        assert!(needs_refresh(Some(100), 15_101, 15_000));
    }
}
