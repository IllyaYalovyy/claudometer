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

function durationLabel(minutes) {
    if (minutes % 1440 === 0) {
        const days = minutes / 1440;
        return `${days}-day window`;
    }
    if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return `${hours}-hour window`;
    }
    return `${minutes}-minute window`;
}

function codexSection(window, index, now, opts) {
    const label = window.limitName ?? 'Codex';
    return {
        kind: `codex:${window.limitId}:${window.slot}:${index}`,
        title: `Codex${label === 'Codex' ? '' : ` · ${label}`} — ` +
            durationLabel(window.durationMins),
        percent: window.percent,
        percentText: formatPercent(window.percent),
        barState: barState(window.percent, opts.warningAt, opts.criticalAt),
        resetText: window.resetsAt == null
            ? null
            : formatResetRow(window.resetsAt, now, {clock24: opts.clock24}),
    };
}

function providerNotice(id, snapshot) {
    const name = id === 'claude' ? 'Claude Code' : 'Codex';
    if (snapshot?.error === NOT_INSTALLED) {
        return {
            headline: `${name} was not found on this system.`,
            detail: `Install ${name}, then refresh.`,
        };
    }
    return {
        headline: `Can't read ${name} usage data.`,
        detail: `Open ${name} and sign in, then refresh.`,
    };
}

function freshnessPart(id, snapshot, now, opts, usable) {
    const name = id === 'claude' ? 'Claude' : 'Codex';
    if (!usable || typeof snapshot?.fetchedAt !== 'number')
        return `${name} unavailable`;
    const text = formatFreshness(snapshot.fetchedAt, now, {
        staleAfterMs: opts.staleAfterMs,
        lastRefreshFailed: opts.lastRefreshFailedByProvider?.[id] ?? false,
    });
    return `${name} ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

function multiProviderMenuModel(snapshot, now, opts) {
    const {
        clock24 = true,
        warningAt = 80,
        criticalAt = 95,
        staleAfterMs = DEFAULT_STALE_AFTER_MS,
    } = opts;
    const values = {clock24, warningAt, criticalAt, staleAfterMs,
        lastRefreshFailedByProvider: opts.lastRefreshFailedByProvider};
    const claude = snapshot.providers?.claude;
    const codex = snapshot.providers?.codex;
    const sections = [];
    if (claude?.session) {
        sections.push({...section('session', claude.session, now, values),
            kind: 'claude:session',
            title: 'Claude — Session (5-hour window)'});
    }
    if (claude?.week) {
        sections.push({...section('week', claude.week, now, values),
            kind: 'claude:week', title: 'Claude — Week (all models)'});
    }
    for (const [index, entry] of (claude?.weekModel ?? []).entries()) {
        sections.push({...section('weekModel', entry, now, values),
            kind: `claude:model:${index}`,
            title: `Claude · ${entry.model} — Week`});
    }
    for (const [index, window] of (codex?.windows ?? []).entries())
        sections.push(codexSection(window, index, now, values));

    const claudeConstraint = constraintOf(claude);
    let codexConstraint = null;
    for (const window of codex?.windows ?? []) {
        if (codexConstraint === null || window.percent > codexConstraint.percent)
            codexConstraint = window;
    }
    const unavailable = [];
    if (claudeConstraint === null)
        unavailable.push(['claude', claude]);
    if (codexConstraint === null)
        unavailable.push(['codex', codex]);

    let notice = null;
    if (unavailable.length === 1) {
        notice = providerNotice(...unavailable[0]);
    } else if (unavailable.length === 2) {
        notice = {
            headline: 'Claude and Codex usage data are unavailable.',
            detail: 'Install or sign in to the provider clients, then refresh.',
        };
    }

    const promoted = [];
    if (claudeConstraint !== null &&
        classify(claude, now, values) === LIMIT_HIT) {
        promoted.push(`Claude ${promotedLine(
            claudeConstraint, now, clock24).toLowerCase()}`);
    }
    if (codexConstraint !== null && codexConstraint.percent >= 100 &&
        now - codex.fetchedAt <= staleAfterMs) {
        const label = codexConstraint.limitName ?? 'Codex';
        const reset = codexConstraint.resetsAt == null
            ? ''
            : ' — ' + formatResetRow(codexConstraint.resetsAt, now, {clock24})
                .toLowerCase();
        promoted.push(`${label} limit reached${reset}`);
    }

    const claudeUsable = claudeConstraint !== null;
    const codexUsable = codexConstraint !== null;
    const freshnessText = [
        freshnessPart('claude', claude, now, values, claudeUsable),
        freshnessPart('codex', codex, now, values, codexUsable),
    ].join(' · ');
    const stale = [
        [claude, claudeUsable],
        [codex, codexUsable],
    ].some(([provider, usable]) => usable &&
        now - provider.fetchedAt > staleAfterMs);

    return {
        promoted: promoted.length === 0 ? null : promoted.join('\n'),
        notice,
        sections,
        footer: {freshnessText, stale},
    };
}

export function menuModel(snapshot, now, opts = {}) {
    if (snapshot?.providers !== undefined)
        return multiProviderMenuModel(snapshot, now, opts);
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
