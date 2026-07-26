// Pure preferences model for the UX §7 settings: defaults, the allowed
// choice sets, and the clamping rules the prefs UI and the extension both
// apply. The GSettings schema enforces per-key ranges, but not the
// warning<critical cross-field rule or the discrete refresh-interval set —
// a CLI write can violate both, so every read goes through the normalize
// functions here. No Shell imports; importable under plain `gjs -m`.

import {HEADLINE_AUTO, HEADLINE_SESSION, HEADLINE_WEEK} from './derive.js';
import {ICON_AND_PERCENT, ICON_ONLY, PERCENT_ONLY} from './indicator_model.js';

// §7 "Indicator style" — the values are indicator_model's display modes,
// stored verbatim in the `indicator-style` key.
export const INDICATOR_STYLES = [ICON_AND_PERCENT, ICON_ONLY, PERCENT_ONLY];

// §7 "Headline metric": auto = most constrained window; session/week pin
// the headline to that window. The values live in derive.js (headlineOf's
// vocabulary) and are stored verbatim in the `headline-metric` key.
export {HEADLINE_AUTO, HEADLINE_SESSION, HEADLINE_WEEK};
export const HEADLINE_METRICS = [HEADLINE_AUTO, HEADLINE_SESSION, HEADLINE_WEEK];

// §6/§7 refresh cadence choices (seconds).
export const REFRESH_INTERVALS_SEC = [30, 60, 120, 300, 600];

// §7 threshold spin ranges. The bounds interlock: warning caps at 95 so
// critical always has room above it, and critical floors at 51 so warning
// always has room below.
export const WARNING_PERCENT_MIN = 50;
export const WARNING_PERCENT_MAX = 95;
export const CRITICAL_PERCENT_MIN = 51;
export const CRITICAL_PERCENT_MAX = 100;

export const DEFAULTS = Object.freeze({
    indicatorStyle: ICON_AND_PERCENT,
    headlineMetric: HEADLINE_AUTO,
    warningPercent: 80,
    criticalPercent: 95,
    refreshIntervalSec: 60,
});

// §3.3 stale trigger: "data older than 3× poll interval" — the stale
// boundary follows the configured cadence, not the 60 s default.
export const STALE_INTERVAL_MULTIPLIER = 3;

// Map normalized §7 preferences onto the options bag the pure render
// models consume (indicator_model, menu_model, and classify() underneath
// them); each destructures only the keys it knows. extension.js rebuilds
// this on every settings change and re-feeds the current snapshot.
export function displayOptions({
    indicatorStyle,
    headlineMetric,
    warningPercent,
    criticalPercent,
    refreshIntervalSec,
}) {
    return {
        displayMode: indicatorStyle,
        headlineMetric,
        warningAt: warningPercent,
        criticalAt: criticalPercent,
        staleAfterMs: STALE_INTERVAL_MULTIPLIER * refreshIntervalSec * 1000,
    };
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeIndicatorStyle(value) {
    return INDICATOR_STYLES.includes(value) ? value : DEFAULTS.indicatorStyle;
}

export function normalizeHeadlineMetric(value) {
    return HEADLINE_METRICS.includes(value) ? value : DEFAULTS.headlineMetric;
}

// Snap to the nearest allowed interval; ties go to the shorter one
// (fresher data over fewer polls). Non-numbers get the default.
export function normalizeRefreshInterval(value) {
    if (!Number.isFinite(value))
        return DEFAULTS.refreshIntervalSec;
    let nearest = REFRESH_INTERVALS_SEC[0];
    for (const sec of REFRESH_INTERVALS_SEC) {
        if (Math.abs(sec - value) < Math.abs(nearest - value))
            nearest = sec;
    }
    return nearest;
}

// §7 wording: "30 s / 1 min / 2 min / 5 min / 10 min".
export function refreshIntervalLabel(sec) {
    return sec < 60 ? `${sec} s` : `${sec / 60} min`;
}

// Repair a stored pair: clamp each into its range, then enforce
// warning<critical by raising critical (warning wins — it is the earlier,
// more conservative signal). warning ≤ 95 guarantees warning+1 ≤ 96 fits.
export function normalizeThresholds({warningPercent, criticalPercent}) {
    if (!Number.isFinite(warningPercent))
        warningPercent = DEFAULTS.warningPercent;
    if (!Number.isFinite(criticalPercent))
        criticalPercent = DEFAULTS.criticalPercent;
    warningPercent = clamp(warningPercent,
        WARNING_PERCENT_MIN, WARNING_PERCENT_MAX);
    criticalPercent = clamp(criticalPercent,
        CRITICAL_PERCENT_MIN, CRITICAL_PERCENT_MAX);
    if (warningPercent >= criticalPercent)
        criticalPercent = warningPercent + 1;
    return {warningPercent, criticalPercent};
}

// UI edit of the warning row: clamp the edited value, push critical up if
// crossed. A non-numeric edit is a no-op (returns the pair normalized).
export function setWarningPercent(thresholds, value) {
    if (!Number.isFinite(value))
        return normalizeThresholds(thresholds);
    return normalizeThresholds({
        warningPercent: clamp(value, WARNING_PERCENT_MIN, WARNING_PERCENT_MAX),
        criticalPercent: thresholds.criticalPercent,
    });
}

// UI edit of the critical row: clamp the edited value, pull warning down
// if crossed (the edited row wins). critical ≥ 51 guarantees critical-1 ≥
// 50 fits warning's floor.
export function setCriticalPercent(thresholds, value) {
    if (!Number.isFinite(value))
        return normalizeThresholds(thresholds);
    const criticalPercent = clamp(value,
        CRITICAL_PERCENT_MIN, CRITICAL_PERCENT_MAX);
    let {warningPercent} = normalizeThresholds(thresholds);
    if (warningPercent >= criticalPercent)
        warningPercent = criticalPercent - 1;
    return {warningPercent, criticalPercent};
}
