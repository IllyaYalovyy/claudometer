// Unit tests for src/lib/settings_model.js: the pure preferences model
// behind the UX §7 prefs window and (next task) the extension's settings
// reads. Covers the schema defaults, enum/interval normalization of
// possibly-garbage stored values, and the warning<critical cross-clamp
// that the prefs UI relies on to make invalid combos impossible.
import {test, assertEquals, runTests} from '../harness.js';
import {
    ICON_AND_PERCENT,
    ICON_ONLY,
    PERCENT_ONLY,
} from '../../src/lib/indicator_model.js';
import {
    CRITICAL_PERCENT_MAX,
    CRITICAL_PERCENT_MIN,
    DEFAULTS,
    HEADLINE_AUTO,
    HEADLINE_METRICS,
    HEADLINE_SESSION,
    HEADLINE_WEEK,
    INDICATOR_STYLES,
    REFRESH_INTERVALS_SEC,
    WARNING_PERCENT_MAX,
    WARNING_PERCENT_MIN,
    normalizeHeadlineMetric,
    normalizeIndicatorStyle,
    normalizeRefreshInterval,
    normalizeThresholds,
    refreshIntervalLabel,
    setCriticalPercent,
    setWarningPercent,
} from '../../src/lib/settings_model.js';

function assertThresholds(actual, warning, critical, message) {
    assertEquals(actual.warningPercent, warning,
        `${message}: warningPercent`);
    assertEquals(actual.criticalPercent, critical,
        `${message}: criticalPercent`);
}

// ---------------------------------------------------- defaults and choices

test('defaults_match_ux_section_7', () => {
    assertEquals(DEFAULTS.indicatorStyle, ICON_AND_PERCENT);
    assertEquals(DEFAULTS.headlineMetric, HEADLINE_AUTO);
    assertEquals(DEFAULTS.warningPercent, 80);
    assertEquals(DEFAULTS.criticalPercent, 95);
    assertEquals(DEFAULTS.refreshIntervalSec, 60);
});

test('indicator_style_choices_are_the_indicator_model_display_modes', () => {
    assertEquals(JSON.stringify(INDICATOR_STYLES),
        JSON.stringify([ICON_AND_PERCENT, ICON_ONLY, PERCENT_ONLY]));
});

test('headline_metric_choices_cover_auto_session_week', () => {
    assertEquals(JSON.stringify(HEADLINE_METRICS),
        JSON.stringify([HEADLINE_AUTO, HEADLINE_SESSION, HEADLINE_WEEK]));
});

test('refresh_interval_choices_are_the_ux_section_7_set', () => {
    assertEquals(JSON.stringify(REFRESH_INTERVALS_SEC),
        JSON.stringify([30, 60, 120, 300, 600]));
});

test('threshold_bounds_match_the_schema_ranges', () => {
    assertEquals(WARNING_PERCENT_MIN, 50);
    assertEquals(WARNING_PERCENT_MAX, 95);
    assertEquals(CRITICAL_PERCENT_MIN, 51);
    assertEquals(CRITICAL_PERCENT_MAX, 100);
});

// ------------------------------------------------------ enum normalization

test('valid_indicator_styles_pass_through', () => {
    for (const style of INDICATOR_STYLES)
        assertEquals(normalizeIndicatorStyle(style), style);
});

test('unknown_indicator_style_falls_back_to_default', () => {
    assertEquals(normalizeIndicatorStyle('percent-and-icon'), ICON_AND_PERCENT);
    assertEquals(normalizeIndicatorStyle(''), ICON_AND_PERCENT);
    assertEquals(normalizeIndicatorStyle(null), ICON_AND_PERCENT);
    assertEquals(normalizeIndicatorStyle(42), ICON_AND_PERCENT);
});

test('valid_headline_metrics_pass_through', () => {
    for (const metric of HEADLINE_METRICS)
        assertEquals(normalizeHeadlineMetric(metric), metric);
});

test('unknown_headline_metric_falls_back_to_default', () => {
    assertEquals(normalizeHeadlineMetric('month'), HEADLINE_AUTO);
    assertEquals(normalizeHeadlineMetric(undefined), HEADLINE_AUTO);
});

// -------------------------------------------------- interval normalization

test('allowed_refresh_intervals_pass_through', () => {
    for (const sec of REFRESH_INTERVALS_SEC)
        assertEquals(normalizeRefreshInterval(sec), sec);
});

test('out_of_set_refresh_interval_snaps_to_nearest_allowed', () => {
    assertEquals(normalizeRefreshInterval(31), 30);
    assertEquals(normalizeRefreshInterval(100), 120);
    assertEquals(normalizeRefreshInterval(599), 600);
});

test('refresh_interval_ties_snap_to_the_shorter_interval', () => {
    // 45 is equidistant from 30 and 60; the shorter (fresher) wins.
    assertEquals(normalizeRefreshInterval(45), 30);
    assertEquals(normalizeRefreshInterval(90), 60);
});

test('refresh_interval_outside_the_range_clamps_to_the_edges', () => {
    assertEquals(normalizeRefreshInterval(0), 30);
    assertEquals(normalizeRefreshInterval(-5), 30);
    assertEquals(normalizeRefreshInterval(7200), 600);
});

test('non_numeric_refresh_interval_falls_back_to_default', () => {
    assertEquals(normalizeRefreshInterval('60'), 60);
    assertEquals(normalizeRefreshInterval(NaN), 60);
    assertEquals(normalizeRefreshInterval(null), 60);
});

test('refresh_interval_labels_match_ux_section_7', () => {
    const labels = REFRESH_INTERVALS_SEC.map(refreshIntervalLabel);
    assertEquals(JSON.stringify(labels),
        JSON.stringify(['30 s', '1 min', '2 min', '5 min', '10 min']));
});

// ------------------------------------------------- threshold normalization

test('valid_stored_thresholds_pass_through', () => {
    assertThresholds(
        normalizeThresholds({warningPercent: 70, criticalPercent: 90}),
        70, 90, 'valid pair');
});

test('out_of_range_stored_thresholds_clamp_to_their_bounds', () => {
    assertThresholds(
        normalizeThresholds({warningPercent: 10, criticalPercent: 200}),
        50, 100, 'both out of range');
});

test('stored_warning_at_or_above_critical_pushes_critical_up', () => {
    // The schema cannot express warning<critical, so a CLI write can
    // violate it; warning is kept, critical raised to warning+1.
    assertThresholds(
        normalizeThresholds({warningPercent: 90, criticalPercent: 60}),
        90, 91, 'inverted pair');
    assertThresholds(
        normalizeThresholds({warningPercent: 95, criticalPercent: 95}),
        95, 96, 'equal pair at warning max');
});

test('non_numeric_stored_thresholds_fall_back_to_defaults', () => {
    assertThresholds(
        normalizeThresholds({warningPercent: 'high', criticalPercent: null}),
        80, 95, 'garbage pair');
});

// ------------------------------------------------------- UI cross-clamping

test('setting_warning_within_range_keeps_critical', () => {
    assertThresholds(
        setWarningPercent({warningPercent: 80, criticalPercent: 95}, 70),
        70, 95, 'plain warning edit');
});

test('setting_warning_clamps_to_its_bounds', () => {
    assertThresholds(
        setWarningPercent({warningPercent: 80, criticalPercent: 95}, 10),
        50, 95, 'below min');
    assertThresholds(
        setWarningPercent({warningPercent: 80, criticalPercent: 99}, 99),
        95, 99, 'above max');
});

test('raising_warning_to_critical_or_above_pushes_critical_up', () => {
    assertThresholds(
        setWarningPercent({warningPercent: 80, criticalPercent: 85}, 90),
        90, 91, 'warning crosses critical');
    assertThresholds(
        setWarningPercent({warningPercent: 80, criticalPercent: 85}, 85),
        85, 86, 'warning equals critical');
    // warning max 95 forces critical to 96 — still within critical's 100 cap.
    assertThresholds(
        setWarningPercent({warningPercent: 80, criticalPercent: 95}, 95),
        95, 96, 'warning at its max');
});

test('setting_critical_within_range_keeps_warning', () => {
    assertThresholds(
        setCriticalPercent({warningPercent: 80, criticalPercent: 95}, 90),
        80, 90, 'plain critical edit');
});

test('setting_critical_clamps_to_its_bounds', () => {
    // Below the schema min behaves exactly like setting the min directly:
    // critical clamps to 51 first, then the cross-clamp moves warning.
    assertThresholds(
        setCriticalPercent({warningPercent: 60, criticalPercent: 95}, 20),
        50, 51, 'below min');
    assertThresholds(
        setCriticalPercent({warningPercent: 80, criticalPercent: 95}, 150),
        80, 100, 'above max');
});

test('lowering_critical_to_warning_or_below_pushes_warning_down', () => {
    assertThresholds(
        setCriticalPercent({warningPercent: 80, criticalPercent: 95}, 75),
        74, 75, 'critical crosses warning');
    assertThresholds(
        setCriticalPercent({warningPercent: 80, criticalPercent: 95}, 80),
        79, 80, 'critical equals warning');
    // critical min 51 forces warning to 50 — still within warning's 50 floor.
    assertThresholds(
        setCriticalPercent({warningPercent: 60, criticalPercent: 95}, 51),
        50, 51, 'critical at its min');
});

test('threshold_edits_round_fractional_spin_values', () => {
    assertThresholds(
        setWarningPercent({warningPercent: 80, criticalPercent: 95}, 72.4),
        72, 95, 'fractional warning');
    assertThresholds(
        setCriticalPercent({warningPercent: 80, criticalPercent: 95}, 90.6),
        80, 91, 'fractional critical');
});

test('non_numeric_threshold_edit_leaves_thresholds_unchanged', () => {
    assertThresholds(
        setWarningPercent({warningPercent: 70, criticalPercent: 90}, NaN),
        70, 90, 'NaN warning edit');
    assertThresholds(
        setCriticalPercent({warningPercent: 70, criticalPercent: 90}, null),
        70, 90, 'null critical edit');
});

runTests();
