// Unit tests for src/lib/indicator_model.js: the panel indicator's render
// model — every designs/UX-DESIGN.md §3.3 table row, the §3.1 display
// modes (with the UX-Q3 limit-hit override), and the §8 accessible-name
// wording. Local-time expectations are built with the local Date
// constructor, so they hold in any timezone.
import {test, assertEquals, runTests} from '../harness.js';
import {
    indicatorModel,
    ICON_AND_PERCENT,
    ICON_ONLY,
    PERCENT_ONLY,
} from '../../src/lib/indicator_model.js';

const MIN = 60000;

// 1 h 12 m before a 17:00 reset — the §3.3 limit-hit example.
const RESET = new Date(2026, 6, 24, 17, 0).getTime();
const NOW = RESET - 72 * MIN;

const MODES = [ICON_AND_PERCENT, ICON_ONLY, PERCENT_ONLY];

// Fresh snapshot whose only window is a session at `percent`.
function sessionAt(percent, fetchedAt = NOW) {
    return {fetchedAt, session: {percent, resetsAt: RESET}};
}

function model(snapshot, opts = {}) {
    return indicatorModel(snapshot, NOW, opts);
}

test('every_3_3_table_row_renders_in_the_default_mode', () => {
    // State name -> [snapshot, labelText, iconVariant, opacity,
    // accessibleName]. One entry per §3.3 row.
    const rows = [
        ['normal', sessionAt(67), '67%', 'meter', 1,
            'Claude usage: 67 percent of session limit used, ' +
            'resets in 1 h 12 m (17:00)'],
        ['warning', sessionAt(84), '84%', 'meter-alert', 1,
            'Claude usage: 84 percent of session limit used, ' +
            'resets in 1 h 12 m (17:00)'],
        ['critical', sessionAt(97), '97%', 'meter-alert', 1,
            'Claude usage: 97 percent of session limit used, ' +
            'resets in 1 h 12 m (17:00)'],
        ['limit-hit', sessionAt(100), '1 h 12 m', 'hourglass', 1,
            'Claude usage: session limit reached, ' +
            'resets in 1 h 12 m (17:00)'],
        ['stale', sessionAt(67, NOW - 25 * MIN), '67%', 'meter', 0.55,
            'Claude usage: 67 percent of session limit used, ' +
            'data is 25 min old'],
        ['unavailable', null, null, 'meter-unavailable', 0.55,
            'Claude usage data unavailable'],
    ];
    for (const [state, snapshot, label, icon, opacity, a11y] of rows) {
        const m = model(snapshot);
        assertEquals(m.labelText, label, `${state}: labelText`);
        assertEquals(m.iconVariant, icon, `${state}: iconVariant`);
        assertEquals(m.opacity, opacity, `${state}: opacity`);
        assertEquals(m.styleClass, `claudometer-${state}`,
            `${state}: styleClass`);
        assertEquals(m.accessibleName, a11y, `${state}: accessibleName`);
    }
});

test('icon_only_mode_drops_the_label_in_every_percent_state', () => {
    const cases = [
        ['normal', sessionAt(67), 'meter'],
        ['warning', sessionAt(84), 'meter-alert'],
        ['critical', sessionAt(97), 'meter-alert'],
        ['stale', sessionAt(67, NOW - 25 * MIN), 'meter'],
    ];
    for (const [state, snapshot, icon] of cases) {
        const m = model(snapshot, {displayMode: ICON_ONLY});
        assertEquals(m.labelText, null, `${state}: labelText`);
        assertEquals(m.iconVariant, icon, `${state}: iconVariant`);
    }
});

test('limit_hit_countdown_overrides_icon_only_mode', () => {
    // UX-Q3 lean: reset time is the one datum worth breaking the user's
    // chosen minimalism for.
    const m = model(sessionAt(100), {displayMode: ICON_ONLY});
    assertEquals(m.labelText, '1 h 12 m');
    assertEquals(m.iconVariant, 'hourglass');
});

test('percent_only_mode_drops_the_icon_in_every_labeled_state', () => {
    const cases = [
        ['normal', sessionAt(67), '67%'],
        ['warning', sessionAt(84), '84%'],
        ['critical', sessionAt(97), '97%'],
        ['limit-hit', sessionAt(100), '1 h 12 m'],
        ['stale', sessionAt(67, NOW - 25 * MIN), '67%'],
    ];
    for (const [state, snapshot, label] of cases) {
        const m = model(snapshot, {displayMode: PERCENT_ONLY});
        assertEquals(m.iconVariant, null, `${state}: iconVariant`);
        assertEquals(m.labelText, label, `${state}: labelText`);
    }
});

test('unavailable_keeps_the_slashed_meter_even_in_percent_only_mode', () => {
    // With no number to show, the icon is the only thing marking the
    // state; percent-only must not render an empty indicator.
    const m = model(null, {displayMode: PERCENT_ONLY});
    assertEquals(m.iconVariant, 'meter-unavailable');
    assertEquals(m.labelText, null);
});

test('unavailable_shows_no_number_anywhere_in_any_mode', () => {
    // §1/§3.3 honesty rule: no label, no digit in the accessible name —
    // in every display mode, for every no-window snapshot shape.
    const snapshots = [
        ['null snapshot', null],
        ['windowless snapshot', {fetchedAt: NOW}],
        ['error snapshot', {fetchedAt: NOW, error: 'unparseable'}],
    ];
    for (const [label, snapshot] of snapshots) {
        for (const mode of MODES) {
            const m = model(snapshot, {displayMode: mode});
            assertEquals(m.labelText, null, `${label} ${mode}: labelText`);
            assertEquals(/\d/.test(m.accessibleName), false,
                `${label} ${mode}: digits in accessibleName`);
        }
    }
});

test('accessible_name_carries_the_full_story_in_every_mode', () => {
    // §8: the a11y string is mode-independent — icon-only must not mute
    // the screen reader.
    for (const mode of MODES) {
        assertEquals(model(sessionAt(84), {displayMode: mode}).accessibleName,
            'Claude usage: 84 percent of session limit used, ' +
            'resets in 1 h 12 m (17:00)', mode);
    }
});

test('limit_hit_without_reset_time_falls_back_to_the_percent', () => {
    // No resetsAt -> no countdown to show and no datum worth overriding
    // icon-only for; the honest label is the (true) 100%.
    const snapshot = {fetchedAt: NOW, session: {percent: 100}};
    const m = model(snapshot);
    assertEquals(m.labelText, '100%');
    assertEquals(m.iconVariant, 'hourglass');
    assertEquals(m.accessibleName, 'Claude usage: session limit reached');
    assertEquals(model(snapshot, {displayMode: ICON_ONLY}).labelText, null);
});

test('missing_reset_time_drops_the_reset_clause', () => {
    const m = model({fetchedAt: NOW, session: {percent: 67}});
    assertEquals(m.accessibleName,
        'Claude usage: 67 percent of session limit used');
});

test('stale_past_the_warning_threshold_keeps_the_alert_meter', () => {
    // §3.3 stale shows the *current* meter dimmed — the alert overlay the
    // fresh value earned is not stripped by going stale.
    const m = model(sessionAt(97, NOW - 25 * MIN));
    assertEquals(m.iconVariant, 'meter-alert');
    assertEquals(m.styleClass, 'claudometer-stale');
    assertEquals(m.opacity, 0.55);
});

test('threshold_and_staleness_options_flow_through_to_classification', () => {
    const warned = model(sessionAt(60), {warningAt: 50});
    assertEquals(warned.styleClass, 'claudometer-warning');
    assertEquals(warned.iconVariant, 'meter-alert');
    const fresh = model(sessionAt(67, NOW - 25 * MIN),
        {staleAfterMs: 30 * MIN});
    assertEquals(fresh.styleClass, 'claudometer-normal');
    assertEquals(fresh.opacity, 1);
});

test('accessible_name_names_the_constraining_window', () => {
    const week = model({fetchedAt: NOW, week: {percent: 42, resetsAt: RESET}});
    assertEquals(week.accessibleName,
        'Claude usage: 42 percent of weekly limit used, ' +
        'resets in 1 h 12 m (17:00)');
    // §4.3: weekly resets beyond 24 h read as a date. 2026-07-28 is a
    // Tuesday.
    const farReset = new Date(2026, 6, 28, 17, 0).getTime();
    const opus = model({
        fetchedAt: NOW,
        weekModel: [{model: 'Opus', percent: 42, resetsAt: farReset}],
    });
    assertEquals(opus.accessibleName,
        'Claude usage: 42 percent of weekly Opus limit used, ' +
        'resets Tue, Jul 28');
});

test('accessible_name_honors_the_12_hour_clock_option', () => {
    const m = model(sessionAt(67), {clock24: false});
    assertEquals(m.accessibleName,
        'Claude usage: 67 percent of session limit used, ' +
        'resets in 1 h 12 m (5:00 PM)');
});

runTests();
