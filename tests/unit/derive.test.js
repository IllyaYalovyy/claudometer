// Unit tests for src/lib/derive.js: UsageSnapshot -> constraint window
// (designs/UX-DESIGN.md §2) and the six indicator states of §3.3, with the
// precedence rules unavailable > stale > thresholds. Snapshots here are
// literals in the §2 display contract — the exact shape snapshot.js emits.
import {test, assertEquals, runTests} from '../harness.js';
import {
    constraintOf,
    classify,
    headlineOf,
    HEADLINE_AUTO,
    HEADLINE_SESSION,
    HEADLINE_WEEK,
    NORMAL,
    WARNING,
    CRITICAL,
    LIMIT_HIT,
    STALE,
    UNAVAILABLE,
} from '../../src/lib/derive.js';

const NOW = 1785000000000;
const RESET = NOW + 3600000;

// Fresh snapshot whose only window is a session at `percent` — the minimal
// input for threshold classification.
function sessionAt(percent, fetchedAt = NOW) {
    return {fetchedAt, session: {percent, resetsAt: RESET}};
}

test('constraint_is_null_when_there_is_nothing_to_constrain', () => {
    const cases = [
        ['null snapshot', null],
        ['undefined snapshot', undefined],
        ['windowless snapshot', {fetchedAt: NOW}],
        ['error snapshot', {fetchedAt: NOW, error: 'unparseable'}],
    ];
    for (const [label, snapshot] of cases)
        assertEquals(constraintOf(snapshot), null, label);
});

test('a_lone_window_is_the_constraint_whichever_it_is', () => {
    const cases = [
        ['session', {fetchedAt: NOW, session: {percent: 27, resetsAt: RESET}},
            {kind: 'session', percent: 27}],
        ['week', {fetchedAt: NOW, week: {percent: 34, resetsAt: RESET}},
            {kind: 'week', percent: 34}],
        ['weekModel', {
            fetchedAt: NOW,
            weekModel: [{model: 'Fable', percent: 17, resetsAt: RESET}],
        }, {kind: 'weekModel', percent: 17}],
    ];
    for (const [label, snapshot, expected] of cases) {
        const constraint = constraintOf(snapshot);
        assertEquals(constraint.kind, expected.kind, `${label}: kind`);
        assertEquals(constraint.percent, expected.percent, `${label}: percent`);
        assertEquals(constraint.resetsAt, RESET, `${label}: resetsAt`);
    }
});

test('the_highest_percent_wins_across_all_window_groups', () => {
    const snapshot = {
        fetchedAt: NOW,
        session: {percent: 27, resetsAt: RESET},
        week: {percent: 34, resetsAt: RESET + 1},
        weekModel: [
            {model: 'Fable', percent: 17, resetsAt: RESET + 2},
            {model: 'Opus', percent: 62, resetsAt: RESET + 3},
        ],
    };
    const constraint = constraintOf(snapshot);
    assertEquals(constraint.kind, 'weekModel');
    assertEquals(constraint.model, 'Opus');
    assertEquals(constraint.percent, 62);
    assertEquals(constraint.resetsAt, RESET + 3);
});

test('equal_percents_break_toward_session_then_week_then_model_order', () => {
    // Documented tie-break: on equal percents the earlier window in the
    // fixed order session, week, weekModel[array order] stays the
    // constraint. Stable, so the headline cannot flap between near-equal
    // windows (§7 pinning rationale).
    const cases = [
        ['session over week', {
            fetchedAt: NOW,
            session: {percent: 50, resetsAt: RESET},
            week: {percent: 50, resetsAt: RESET + 1},
        }, {kind: 'session'}],
        ['week over scoped', {
            fetchedAt: NOW,
            week: {percent: 50, resetsAt: RESET},
            weekModel: [{model: 'Opus', percent: 50, resetsAt: RESET + 1}],
        }, {kind: 'week'}],
        ['first scoped entry over later ones', {
            fetchedAt: NOW,
            weekModel: [
                {model: 'Fable', percent: 50, resetsAt: RESET},
                {model: 'Opus', percent: 50, resetsAt: RESET + 1},
            ],
        }, {kind: 'weekModel', model: 'Fable'}],
    ];
    for (const [label, snapshot, expected] of cases) {
        const constraint = constraintOf(snapshot);
        assertEquals(constraint.kind, expected.kind, label);
        if (expected.model !== undefined)
            assertEquals(constraint.model, expected.model, `${label}: model`);
    }
});

test('classifies_every_threshold_boundary_at_the_defaults', () => {
    // §3.3 with default warningAt 80 / criticalAt 95; both bounds inclusive
    // on the more-severe side.
    const cases = [
        [0, NORMAL], [79, NORMAL], [79.9, NORMAL],
        [80, WARNING], [94, WARNING],
        [95, CRITICAL], [99, CRITICAL], [99.9, CRITICAL],
        [100, LIMIT_HIT],
    ];
    for (const [percent, expected] of cases)
        assertEquals(classify(sessionAt(percent), NOW), expected,
            `percent ${percent}`);
});

test('threshold_options_override_the_defaults', () => {
    const opts = {warningAt: 50, criticalAt: 90};
    const cases = [
        [49, NORMAL], [50, WARNING], [89, WARNING], [90, CRITICAL],
        [100, LIMIT_HIT],
    ];
    for (const [percent, expected] of cases)
        assertEquals(classify(sessionAt(percent), NOW, opts), expected,
            `percent ${percent}`);
});

test('classifies_by_the_constraint_not_by_the_first_window', () => {
    const snapshot = {
        fetchedAt: NOW,
        session: {percent: 12, resetsAt: RESET},
        week: {percent: 97, resetsAt: RESET + 1},
    };
    assertEquals(classify(snapshot, NOW), CRITICAL);
});

test('stale_beats_warning_critical_and_limit_hit', () => {
    // §3.3 precedence: data older than staleAfterMs dims whatever threshold
    // state the numbers would otherwise show — including a stale 100%,
    // whose countdown can no longer be trusted.
    const opts = {staleAfterMs: 180000};
    for (const percent of [10, 84, 97, 100]) {
        assertEquals(
            classify(sessionAt(percent, NOW - 180001), NOW, opts), STALE,
            `stale percent ${percent}`);
    }
});

test('age_exactly_at_the_stale_limit_is_still_fresh', () => {
    // "Older than" is strict: an age of exactly staleAfterMs classifies by
    // thresholds, one ms more is stale.
    const opts = {staleAfterMs: 180000};
    assertEquals(classify(sessionAt(84, NOW - 180000), NOW, opts), WARNING);
    assertEquals(classify(sessionAt(84, NOW - 180001), NOW, opts), STALE);
});

test('stale_default_is_three_times_the_default_poll_interval', () => {
    // 3 x 60 s (§3.3 with §6's default cadence) when no staleAfterMs given.
    assertEquals(classify(sessionAt(10, NOW - 180000), NOW), NORMAL);
    assertEquals(classify(sessionAt(10, NOW - 180001), NOW), STALE);
});

test('unavailable_beats_everything_including_staleness', () => {
    const ancient = NOW - 86400000;
    const cases = [
        ['null snapshot', null],
        ['windowless snapshot', {fetchedAt: NOW}],
        ['ancient error snapshot', {fetchedAt: ancient, error: 'unparseable'}],
    ];
    for (const [label, snapshot] of cases)
        assertEquals(classify(snapshot, NOW), UNAVAILABLE, label);
});

test('headline_pins_to_the_chosen_window_when_it_exists', () => {
    // §7 "Headline metric": session/week pin the panel headline to that
    // window even when another window is more constrained.
    const snapshot = {
        fetchedAt: NOW,
        session: {percent: 27, resetsAt: RESET},
        week: {percent: 62, resetsAt: RESET + 1},
    };
    const session = headlineOf(snapshot, HEADLINE_SESSION);
    assertEquals(session.kind, 'session');
    assertEquals(session.percent, 27);
    assertEquals(session.resetsAt, RESET);
    const week = headlineOf(snapshot, HEADLINE_WEEK);
    assertEquals(week.kind, 'week');
    assertEquals(week.percent, 62);
});

test('headline_auto_and_missing_metric_are_the_constraint', () => {
    const snapshot = {
        fetchedAt: NOW,
        session: {percent: 27, resetsAt: RESET},
        week: {percent: 62, resetsAt: RESET + 1},
    };
    assertEquals(headlineOf(snapshot, HEADLINE_AUTO).kind, 'week', 'auto');
    assertEquals(headlineOf(snapshot).kind, 'week', 'metric omitted');
});

test('pinning_to_an_absent_window_falls_back_to_the_constraint', () => {
    // Pinning picks among windows the plan actually has (§1 honesty): a
    // session pin on a week-only snapshot headlines the week, and a pin on
    // a windowless snapshot is still the unavailable state, never a
    // fabricated window.
    const weekOnly = {fetchedAt: NOW, week: {percent: 62, resetsAt: RESET}};
    assertEquals(headlineOf(weekOnly, HEADLINE_SESSION).kind, 'week');
    assertEquals(headlineOf({fetchedAt: NOW}, HEADLINE_SESSION), null);
    assertEquals(headlineOf(null, HEADLINE_WEEK), null);
});

test('classification_follows_the_pinned_headline_window', () => {
    // §7 rationale: a user pinned to the session window chose not to care
    // about the weekly one — the indicator must not go critical for it.
    const snapshot = {
        fetchedAt: NOW,
        session: {percent: 12, resetsAt: RESET},
        week: {percent: 97, resetsAt: RESET + 1},
    };
    assertEquals(classify(snapshot, NOW, {headlineMetric: HEADLINE_SESSION}),
        NORMAL);
    assertEquals(classify(snapshot, NOW, {headlineMetric: HEADLINE_WEEK}),
        CRITICAL);
    assertEquals(classify(snapshot, NOW, {headlineMetric: HEADLINE_AUTO}),
        CRITICAL);
});

test('exports_the_six_states_as_stable_strings', () => {
    // Shared vocabulary for the indicator, menu, and logs; renaming a value
    // is a cross-module breaking change.
    assertEquals(NORMAL, 'normal');
    assertEquals(WARNING, 'warning');
    assertEquals(CRITICAL, 'critical');
    assertEquals(LIMIT_HIT, 'limit-hit');
    assertEquals(STALE, 'stale');
    assertEquals(UNAVAILABLE, 'unavailable');
});

runTests();
