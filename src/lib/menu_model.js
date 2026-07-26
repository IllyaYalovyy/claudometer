// Pure render model for the dropdown menu: (snapshot, now, opts) -> the
// section and footer descriptors of designs/UX-DESIGN.md §4.1–§4.5. The
// St layer (src/menu.js) renders descriptors 1:1; all layout decisions
// live here. No Shell imports; importable under plain `gjs -m`.
//
// Model shape:
//   promoted    §4.5 limit-hit promotion: the constraint's reset row
//               recast as the menu's first line ('Session limit reached —
//               resets in 1 h 12 m (17:00)'), or null. Stale beats
//               limit-hit (derive.js precedence), so stale data never
//               promotes a reset promise that may already have passed.
//   notice      §4.5 unavailable block, or null. {headline, detail} —
//               plain-language sentence first, then the action. Wording
//               comes from a fixed table keyed on the failure taxonomy;
//               a raw error string can never reach the menu (raw causes
//               go to console.warn/the journal in the IO layers).
//   sections[]  one entry per window present in the snapshot, in the §4.1
//               order session, week-all-models, per-model weeks; absent
//               windows produce nothing (no empty placeholders):
//     kind         'session' | 'week' | 'weekModel' (derive.js vocabulary)
//     title        §4.1 section title row text
//     percent      raw fill datum for the §4.2 bar (0–100)
//     percentText  the §4.2 accompanying number, e.g. '67%'
//     barState     'normal' | 'warning' | 'critical' — this window's own
//                  percent against the thresholds, independent per bar
//     resetText    §4.3 reset row, or null for no row (missing resetsAt
//                  renders nothing, never a fabricated countdown — §1)
//   footer        the §4.4 row:
//     freshnessText  'Updated 2 min ago' wording, stale wording past
//                    staleAfterMs (the '— last refresh failed' clause
//                    only when opts.lastRefreshFailed reports a real
//                    spawn failure — #16); 'Last tried 1 min ago' when the
//                    snapshot is unavailable (§4.5 — nothing was
//                    updated); null before any fetch and in the
//                    not-installed state (nothing honest to date-stamp,
//                    no installation to retry against)
//     stale          whether the line carries the warning color (§4.4)

import {
    classify,
    constraintOf,
    LIMIT_HIT,
    NORMAL,
    UNAVAILABLE,
    WARNING,
    CRITICAL,
    DEFAULT_STALE_AFTER_MS,
} from './derive.js';
import {NOT_INSTALLED} from './snapshot.js';
import {
    formatFreshness,
    formatLastTried,
    formatPercent,
    formatResetRow,
} from './format.js';

// §4.1 titles. The em dash is the mockup's, not a hyphen.
function sectionTitle(kind, model) {
    if (kind === 'session')
        return 'Session (5-hour window)';
    if (kind === 'week')
        return 'Week — all models';
    return `Week — ${model}`;
}

// §4.2: each bar colors by its own window's thresholds. The §4.5 full
// limit-hit bar falls out of criticalAt <= 100.
function barState(percent, warningAt, criticalAt) {
    if (percent >= criticalAt)
        return CRITICAL;
    if (percent >= warningAt)
        return WARNING;
    return NORMAL;
}

function section(kind, window, now, {clock24, warningAt, criticalAt}) {
    return {
        kind,
        title: sectionTitle(kind, window.model),
        percent: window.percent,
        percentText: formatPercent(window.percent),
        barState: barState(window.percent, warningAt, criticalAt),
        resetText: window.resetsAt == null
            ? null
            : formatResetRow(window.resetsAt, now, {clock24}),
    };
}

// §4.5 wording table. Only NOT_INSTALLED is distinguishable to the user
// (§4.5 groups unreadable and signed-out); everything else — including an
// error value this table has never seen — gets the generic block, so no
// raw error string can surface by construction.
function notice(error) {
    if (error === NOT_INSTALLED) {
        return {
            headline: 'Claude Code was not found on this system.',
            detail: 'Claudometer reads usage from a local Claude Code ' +
                'installation.',
        };
    }
    return {
        headline: "Can't read usage data.",
        detail: 'Open Claude Code and sign in, then refresh.',
    };
}

// §4.5 limit-hit promotion: '<Window> limit reached — resets in …', the
// reset half reusing the §4.3 row verbatim (lowercased into the clause).
function promotedLine(constraint, now, clock24) {
    let name;
    if (constraint.kind === 'session')
        name = 'Session';
    else if (constraint.kind === 'week')
        name = 'Weekly';
    else
        name = `Weekly ${constraint.model}`;
    if (constraint.resetsAt == null)
        return `${name} limit reached`;
    const row = formatResetRow(constraint.resetsAt, now, {clock24});
    return `${name} limit reached — ` +
        `${row.charAt(0).toLowerCase()}${row.slice(1)}`;
}

export function menuModel(snapshot, now, opts = {}) {
    const {
        clock24 = true,
        warningAt = 80,
        criticalAt = 95,
        staleAfterMs = DEFAULT_STALE_AFTER_MS,
        lastRefreshFailed = false,
    } = opts;
    const optValues = {clock24, warningAt, criticalAt};

    const sections = [];
    if (snapshot?.session)
        sections.push(section('session', snapshot.session, now, optValues));
    if (snapshot?.week)
        sections.push(section('week', snapshot.week, now, optValues));
    for (const entry of snapshot?.weekModel ?? [])
        sections.push(section('weekModel', entry, now, optValues));

    const state = classify(snapshot, now, {warningAt, criticalAt, staleAfterMs});
    const unavailable = state === UNAVAILABLE;

    const fetchedAt = snapshot?.fetchedAt;
    let footer;
    if (typeof fetchedAt !== 'number' ||
        (unavailable && snapshot.error === NOT_INSTALLED)) {
        footer = {freshnessText: null, stale: false};
    } else if (unavailable) {
        footer = {freshnessText: formatLastTried(fetchedAt, now), stale: false};
    } else {
        footer = {
            freshnessText: formatFreshness(fetchedAt, now,
                {staleAfterMs, lastRefreshFailed}),
            // Same strict boundary as derive.js's STALE and the
            // formatFreshness wording flip.
            stale: now - fetchedAt > staleAfterMs,
        };
    }

    return {
        promoted: state === LIMIT_HIT
            ? promotedLine(constraintOf(snapshot), now, clock24)
            : null,
        notice: unavailable ? notice(snapshot?.error) : null,
        sections,
        footer,
    };
}
