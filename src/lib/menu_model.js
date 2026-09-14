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
//   groups[]    optional provider groups for a composite snapshot. Provider
//               names/icons live here once, never in every window title;
//               Codex groups may carry one quiet reset-credit note.
//   sections[]  flattened compatibility view of the grouped windows, in
//               Claude then Codex order; absent windows produce nothing:
//     kind         'session' | 'week' | 'weekModel' (derive.js vocabulary)
//     providerName composite-only provider context for accessibility
//     bucketName   Codex bucket context retained for accessibility
//     bucketTitle  bounded Codex bucket heading on its first row, else null
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
    formatAge,
    formatFreshness,
    formatLastTried,
    formatPercent,
    formatResetRow,
} from './format.js';

const MAX_DYNAMIC_LABEL_CHARS = 24;
const MINUTE_MS = 60000;

function boundedLabel(value) {
    const chars = Array.from(value);
    if (chars.length <= MAX_DYNAMIC_LABEL_CHARS)
        return value;
    return `${chars.slice(0, MAX_DYNAMIC_LABEL_CHARS - 1).join('')}…`;
}

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

function durationLabel(minutes, slot) {
    if (minutes === undefined)
        return slot === 'primary' ? 'Current window' : 'Additional window';
    if (minutes % 1440 === 0) {
        const days = minutes / 1440;
        return `${days} ${days === 1 ? 'day' : 'days'}`;
    }
    if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
    }
    return `${minutes} min`;
}

function codexBucketName(window, mainLimitId) {
    if (window.limitId === mainLimitId)
        return 'Included usage';
    return window.limitName == null
        ? 'Other usage'
        : boundedLabel(window.limitName);
}

function codexSection(window, index, bucketName, first, denied, now, opts) {
    return {
        kind: `codex:${window.limitId}:${window.slot}:${index}`,
        providerName: 'Codex',
        bucketName,
        bucketTitle: first ? bucketName : null,
        title: durationLabel(window.durationMins, window.slot),
        percent: window.percent,
        percentText: formatPercent(window.percent),
        barState: denied || typeof window.reachedType === 'string'
            ? CRITICAL
            : barState(window.percent, opts.warningAt, opts.criticalAt),
        resetText: window.resetsAt == null
            ? null
            : formatResetRow(window.resetsAt, now, {clock24: opts.clock24}),
    };
}

function codexMainLimitId(snapshot) {
    const windows = snapshot?.windows ?? [];
    return snapshot?.mainLimitId ??
        windows.find(window => window.limitId === 'codex')?.limitId ??
        windows.find(window => window.limitName === undefined)?.limitId ?? null;
}

function codexConstraint(snapshot) {
    const mainLimitId = codexMainLimitId(snapshot);
    let constraint = null;
    for (const window of snapshot?.windows ?? []) {
        if (window.limitId !== mainLimitId)
            continue;
        if (constraint === null || window.percent > constraint.percent)
            constraint = window;
    }
    return constraint;
}

function codexSections(snapshot, now, opts) {
    const buckets = new Map();
    for (const [index, window] of (snapshot?.windows ?? []).entries()) {
        if (!buckets.has(window.limitId))
            buckets.set(window.limitId, []);
        buckets.get(window.limitId).push({index, window});
    }
    const mainLimitId = codexMainLimitId(snapshot);
    return [...buckets.values()].flatMap(entries => {
        const bucketName = codexBucketName(entries[0].window, mainLimitId);
        const denied = entries[0].window.limitId === mainLimitId &&
            snapshot?.ordinaryUsageAllowed === false;
        return entries.map(({index, window}, bucketIndex) => codexSection(
            window, index, bucketName, bucketIndex === 0, denied, now, opts));
    });
}

function codexAccessUnknown(snapshot) {
    return snapshot !== null && typeof snapshot === 'object' &&
        Object.hasOwn(snapshot, 'ordinaryUsageAllowed') &&
        snapshot.ordinaryUsageAllowed === null;
}

function codexResetCreditText(snapshot) {
    const count = snapshot?.resetCreditsAvailable;
    if (!Number.isSafeInteger(count) || count <= 0)
        return null;
    return `${count} rate-limit ${count === 1 ? 'reset' : 'resets'} available`;
}

function codexPromotionLines(snapshot, now, clock24) {
    const mainLimitId = codexMainLimitId(snapshot);
    const buckets = new Map();
    for (const window of snapshot?.windows ?? []) {
        if (!buckets.has(window.limitId))
            buckets.set(window.limitId, []);
        buckets.get(window.limitId).push(window);
    }
    const lines = [];
    for (const windows of buckets.values()) {
        const first = windows[0];
        const reachedType = windows.find(window =>
            typeof window.reachedType === 'string')?.reachedType;
        const reachedWindow = windows.find(window => window.percent >= 100) ??
            windows.reduce((best, window) =>
                best === null || window.percent > best.percent ? window : best,
            null);
        const ordinaryDenied = first.limitId === mainLimitId &&
            snapshot?.ordinaryUsageAllowed === false;
        if (reachedType === undefined && !ordinaryDenied &&
            !windows.some(window => window.percent >= 100))
            continue;

        let text;
        if (reachedType === 'workspace_owner_credits_depleted' ||
            reachedType === 'workspace_member_credits_depleted') {
            text = 'Codex workspace credits depleted';
        } else if (reachedType === 'workspace_owner_usage_limit_reached' ||
                   reachedType === 'workspace_member_usage_limit_reached') {
            text = 'Codex workspace usage limit reached';
        } else if (ordinaryDenied && reachedType === undefined) {
            text = 'Codex included usage unavailable';
        } else {
            const name = first.limitId === mainLimitId
                ? 'Codex included usage'
                : codexBucketName(first, mainLimitId);
            text = `${name} limit reached`;
        }

        const resetIsAuthoritative = reachedType === 'rate_limit_reached' ||
            (reachedType === undefined && !ordinaryDenied);
        if (resetIsAuthoritative && reachedWindow?.resetsAt != null) {
            const reset = formatResetRow(reachedWindow.resetsAt, now, {clock24});
            text += ` — ${reset.charAt(0).toLowerCase()}${reset.slice(1)}`;
        }
        lines.push(text);
    }
    return lines;
}

function providerNotice(id, snapshot) {
    const name = id === 'claude' ? 'Claude Code' : 'Codex';
    if (snapshot?.error === NOT_INSTALLED) {
        return {
            headline: `${name} was not found on this system.`,
            detail: `Install ${name}, then refresh.`,
        };
    }
    if (id === 'codex' && codexAccessUnknown(snapshot)) {
        return {
            headline: 'Codex access status is unavailable.',
            detail: 'Refresh Codex usage data to check again.',
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
    const age = Math.max(0, now - snapshot.fetchedAt);
    if (age > opts.staleAfterMs) {
        const failed = opts.lastRefreshFailedByProvider?.[id] ?? false;
        return `${name} ${formatAge(age)} old${failed ? ' (failed)' : ''}`;
    }
    if (age < 30000)
        return `${name} now`;
    return `${name} ${Math.round(age / MINUTE_MS)} min`;
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
    const claudeSections = [];
    if (claude?.session) {
        claudeSections.push({...section('session', claude.session, now, values),
            kind: 'claude:session',
            providerName: 'Claude',
            title: 'Session · 5 hours'});
    }
    if (claude?.week) {
        claudeSections.push({...section('week', claude.week, now, values),
            kind: 'claude:week', providerName: 'Claude',
            title: 'All models · 7 days'});
    }
    for (const [index, entry] of (claude?.weekModel ?? []).entries()) {
        claudeSections.push({...section('weekModel', entry, now, values),
            kind: `claude:model:${index}`,
            providerName: 'Claude',
            title: `${boundedLabel(entry.model)} · 7 days`});
    }
    const renderedCodexSections = codexSections(codex, now, values);
    const groups = [{
        id: 'claude',
        title: 'Claude',
        mark: 'claude',
        sections: claudeSections,
    }, {
        id: 'codex',
        title: 'Codex',
        mark: 'codex',
        sections: renderedCodexSections,
        note: codexResetCreditText(codex),
    }].filter(group => group.sections.length > 0 || group.note != null);
    const sections = groups.flatMap(group => group.sections);

    const claudeConstraint = constraintOf(claude);
    const mainCodexConstraint = codexConstraint(codex);
    const unavailable = [];
    if (claudeConstraint === null)
        unavailable.push(['claude', claude]);
    if (mainCodexConstraint === null || codexAccessUnknown(codex))
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
    if (codex?.windows?.length > 0 &&
        now - codex.fetchedAt <= staleAfterMs)
        promoted.push(...codexPromotionLines(codex, now, clock24));

    const claudeUsable = claudeConstraint !== null;
    const codexUsable = mainCodexConstraint !== null &&
        !codexAccessUnknown(codex);
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
        groups,
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
