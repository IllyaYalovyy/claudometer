// Pure render model for the dropdown menu: (snapshot, now, opts) -> the
// section and footer descriptors of designs/UX-DESIGN.md §4.1–§4.4. The
// St layer (src/menu.js) renders descriptors 1:1; all layout decisions
// live here. No Shell imports; importable under plain `gjs -m`.
//
// Model shape:
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
//                    staleAfterMs; null before any fetch (nothing honest
//                    to date-stamp)
//     stale          whether the line carries the warning color (§4.4)

import {NORMAL, WARNING, CRITICAL, DEFAULT_STALE_AFTER_MS} from './derive.js';
import {formatFreshness, formatPercent, formatResetRow} from './format.js';

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

export function menuModel(snapshot, now, opts = {}) {
    const {
        clock24 = true,
        warningAt = 80,
        criticalAt = 95,
        staleAfterMs = DEFAULT_STALE_AFTER_MS,
    } = opts;
    const optValues = {clock24, warningAt, criticalAt};

    const sections = [];
    if (snapshot?.session)
        sections.push(section('session', snapshot.session, now, optValues));
    if (snapshot?.week)
        sections.push(section('week', snapshot.week, now, optValues));
    for (const entry of snapshot?.weekModel ?? [])
        sections.push(section('weekModel', entry, now, optValues));

    const fetchedAt = snapshot?.fetchedAt;
    const footer = typeof fetchedAt === 'number'
        ? {
            freshnessText: formatFreshness(fetchedAt, now, {staleAfterMs}),
            // Same strict boundary as derive.js's STALE and the
            // formatFreshness wording flip.
            stale: now - fetchedAt > staleAfterMs,
        }
        : {freshnessText: null, stale: false};

    return {sections, footer};
}
