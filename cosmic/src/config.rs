//! UX-DESIGN §7 preferences, persisted through cosmic-config (port of the
//! GSettings schema and `src/lib/settings_model.js`).
//!
//! The file lives at `~/.config/cosmic/<APP_ID>/v1/<key>`; the applet
//! subscribes to changes, so an edit from any tool applies live without a
//! restart. Every read goes through the normalizers here: the store cannot
//! express the warning<critical cross-field rule or the discrete interval set.

use cosmic::cosmic_config::{
    self, ConfigGet, CosmicConfigEntry, cosmic_config_derive::CosmicConfigEntry,
};

pub const APP_ID: &str = "io.github.illyayalovyy.cosmic-ext-applet-claudometer";
pub const CONFIG_VERSION: u64 = 1;

/// §6/§7 refresh cadence choices (seconds).
pub const REFRESH_INTERVALS_SEC: [u32; 5] = [30, 60, 120, 300, 600];

/// §7 threshold spin ranges. The bounds interlock: warning caps at 95 so
/// critical always has room above it, and critical floors at 51 so warning
/// always has room below.
pub const WARNING_PERCENT_MIN: u32 = 50;
pub const WARNING_PERCENT_MAX: u32 = 95;
pub const CRITICAL_PERCENT_MIN: u32 = 51;
pub const CRITICAL_PERCENT_MAX: u32 = 100;

/// §3.3 stale trigger: "data older than 3× poll interval".
pub const STALE_INTERVAL_MULTIPLIER: i64 = 3;

#[derive(Debug, Clone, PartialEq, Eq, CosmicConfigEntry)]
#[version = 1]
pub struct Settings {
    /// Usage percentage at which a meter enters the warning state.
    pub warning_percent: u32,
    /// Usage percentage at which a meter enters the critical state.
    pub critical_percent: u32,
    /// Background poll cadence; snapped to `REFRESH_INTERVALS_SEC`.
    pub refresh_interval_seconds: u32,
    /// Latched when a CLI refresh envelope could not prove zero model cost
    /// (RFC-001 G1 tripwire). Cleared only by explicit user action.
    pub refresh_path_disabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            warning_percent: 80,
            critical_percent: 95,
            refresh_interval_seconds: 60,
            refresh_path_disabled: false,
        }
    }
}

impl Settings {
    /// Repair a stored value set: clamp each threshold into its range, enforce
    /// warning<critical by raising critical (warning wins — it is the earlier,
    /// more conservative signal), snap the interval to the nearest choice.
    pub fn normalized(mut self) -> Self {
        self.warning_percent = self
            .warning_percent
            .clamp(WARNING_PERCENT_MIN, WARNING_PERCENT_MAX);
        self.critical_percent = self
            .critical_percent
            .clamp(CRITICAL_PERCENT_MIN, CRITICAL_PERCENT_MAX);
        if self.warning_percent >= self.critical_percent {
            self.critical_percent = self.warning_percent + 1;
        }
        self.refresh_interval_seconds = normalize_refresh_interval(self.refresh_interval_seconds);
        self
    }

    /// UI edit of the warning row: clamp, push critical up if crossed.
    pub fn with_warning(mut self, value: u32) -> Self {
        self.warning_percent = value.clamp(WARNING_PERCENT_MIN, WARNING_PERCENT_MAX);
        self.normalized()
    }

    /// UI edit of the critical row: clamp, pull warning down if crossed (the
    /// edited row wins).
    pub fn with_critical(mut self, value: u32) -> Self {
        self.critical_percent = value.clamp(CRITICAL_PERCENT_MIN, CRITICAL_PERCENT_MAX);
        if self.warning_percent >= self.critical_percent {
            self.warning_percent = self.critical_percent - 1;
        }
        self.normalized()
    }

    /// The stale boundary follows the configured cadence, not the 60 s default.
    pub fn stale_after_ms(&self) -> i64 {
        STALE_INTERVAL_MULTIPLIER * i64::from(self.refresh_interval_seconds) * 1000
    }
}

/// Snap to the nearest allowed interval; ties go to the shorter one.
pub fn normalize_refresh_interval(value: u32) -> u32 {
    let mut nearest = REFRESH_INTERVALS_SEC[0];
    for sec in REFRESH_INTERVALS_SEC {
        if sec.abs_diff(value) < nearest.abs_diff(value) {
            nearest = sec;
        }
    }
    nearest
}

/// §7 wording: "30 s / 1 min / 2 min / 5 min / 10 min".
pub fn refresh_interval_label(sec: u32) -> String {
    if sec < 60 {
        format!("{sec} s")
    } else {
        format!("{} min", sec / 60)
    }
}

/// Open the applet's config store. `None` when there is no config directory
/// (the applet then runs on defaults and cannot persist edits).
pub fn open() -> Option<cosmic_config::Config> {
    match cosmic_config::Config::new(APP_ID, CONFIG_VERSION) {
        Ok(config) => Some(config),
        Err(why) => {
            eprintln!("claudometer: config store unavailable: {why}");
            None
        }
    }
}

/// Load (and normalize) the stored settings; missing keys keep defaults.
pub fn load(config: Option<&cosmic_config::Config>) -> Settings {
    let Some(config) = config else {
        return Settings::default();
    };
    match Settings::get_entry(config) {
        Ok(settings) => settings.normalized(),
        Err((errors, settings)) => {
            for why in errors {
                eprintln!("claudometer: settings: {why}");
            }
            settings.normalized()
        }
    }
}

/// Persist every key. The applet's own write echoes back through the config
/// subscription as a no-op re-apply.
pub fn save(config: Option<&cosmic_config::Config>, settings: &Settings) {
    if let Some(config) = config
        && let Err(why) = settings.write_entry(config)
    {
        eprintln!("claudometer: could not save settings: {why}");
    }
}

/// The COSMIC clock applet's 12/24-hour preference (§4.3: times honor the
/// system clock format). Absent or unreadable → 12-hour, the applet's default.
pub const TIME_APPLET_ID: &str = "com.system76.CosmicAppletTime";

#[derive(Debug, Clone, Default, PartialEq, Eq, CosmicConfigEntry)]
#[version = 1]
pub struct TimeAppletConfig {
    pub military_time: bool,
}

pub fn load_clock24() -> bool {
    cosmic_config::Config::new(TIME_APPLET_ID, 1)
        .ok()
        .and_then(|config| config.get::<bool>("military_time").ok())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thresholds_stay_in_range_and_ordered() {
        let s = Settings {
            warning_percent: 99,
            critical_percent: 20,
            ..Settings::default()
        }
        .normalized();
        assert_eq!((s.warning_percent, s.critical_percent), (95, 96));
        let s = Settings::default().with_critical(60);
        assert_eq!((s.warning_percent, s.critical_percent), (59, 60));
        let s = Settings::default().with_warning(90);
        assert_eq!((s.warning_percent, s.critical_percent), (90, 95));
        let s = Settings::default().with_warning(95);
        assert_eq!((s.warning_percent, s.critical_percent), (95, 96));
        let s = Settings::default().with_critical(51);
        assert_eq!((s.warning_percent, s.critical_percent), (50, 51));
    }

    #[test]
    fn intervals_snap_to_choices() {
        assert_eq!(normalize_refresh_interval(0), 30);
        assert_eq!(normalize_refresh_interval(45), 30);
        assert_eq!(normalize_refresh_interval(46), 60);
        assert_eq!(normalize_refresh_interval(400), 300);
        assert_eq!(normalize_refresh_interval(10_000), 600);
        assert_eq!(refresh_interval_label(30), "30 s");
        assert_eq!(refresh_interval_label(600), "10 min");
        assert_eq!(Settings::default().stale_after_ms(), 180_000);
    }
}
