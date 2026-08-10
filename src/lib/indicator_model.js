// Pure render model for the panel indicator: (snapshot, now, opts) -> what
// the St widget should show, per designs/UX-DESIGN.md §3 and §8. All
// decisions live here so they are unit-testable without St; the widget
// (src/indicator.js) only applies the result. No Shell imports; importable
// under plain `gjs -m`.
//
// Model shape:
//   labelText      string to show, or null to hide the label
//   styleClass     `claudometer-<state>` for the six §3.3 states
//   opacity        1, or 0.55 for the dimmed stale/unavailable states
//   accessibleName full §8 story, independent of display mode
//   iconVariant    semantic icon token, or null to hide the icon:
//                  'meter' | 'meter-alert' (the §3.3 `!` overlay) |
//                  'hourglass' | 'meter-unavailable' (outline + slash)
//   iconPercent    fill percent for the meter variants' clockwise gauge
//                  (§3.1); null for hourglass/unavailable, which draw no
//                  fill — never a fabricated number (§1)

import {
    classify,
    constraintOf,
    CRITICAL,
    headlineOf,
    HEADLINE_AUTO,
    LIMIT_HIT,
    NORMAL,
    STALE,
    UNAVAILABLE,
    WARNING,
} from './derive.js';
import {
    formatAge,
    formatCountdown,
    formatPercent,
    formatResetRow,
} from './format.js';

// §3.1/§7 display modes ("Indicator style" preference).
export const ICON_AND_PERCENT = 'icon-and-percent';
export const ICON_ONLY = 'icon-only';
export const PERCENT_ONLY = 'percent-only';

// §3.3: stale/unavailable render at 55% opacity.
const DIM_OPACITY = 0.55;

const PROVIDERS = [
    {id: 'claude', name: 'Claude', symbol: 'spark'},
    {id: 'codex', name: 'Codex', symbol: 'code'},
];

function windowName(constraint) {
    if (constraint.kind === 'session')
        return 'session';
    if (constraint.kind === 'week')
        return 'weekly';
    return `weekly ${constraint.model}`;
}

// ", resets in 2 h 15 m (17:00)" / ", resets Tue, Jul 28" — the §4.3 reset
// row recast as an accessible-name clause; empty when the constraint
// carries no reset time.
function resetClause(constraint, now, clock24) {
    if (constraint.resetsAt == null)
        return '';
    const row = formatResetRow(constraint.resetsAt, now, {clock24});
    return `, ${row.charAt(0).toLowerCase()}${row.slice(1)}`;
}

function codexConstraint(snapshot) {
    let constraint = null;
    for (const window of snapshot?.windows ?? []) {
        if (constraint === null || window.percent > constraint.percent)
            constraint = window;
    }
    return constraint;
}

function providerItem(provider, snapshot, now, opts) {
    const {
        warningAt = 80,
        criticalAt = 95,
        staleAfterMs = 3 * 60000,
    } = opts;
    const constraint = provider.id === 'claude'
        ? constraintOf(snapshot)
        : codexConstraint(snapshot);
    let state;
    if (constraint === null) {
        state = UNAVAILABLE;
    } else if (now - snapshot.fetchedAt > staleAfterMs) {
        state = STALE;
    } else if (constraint.percent >= 100) {
        state = LIMIT_HIT;
    } else if (constraint.percent >= criticalAt) {
        state = CRITICAL;
    } else if (constraint.percent >= warningAt) {
        state = WARNING;
    } else {
        state = NORMAL;
    }

    if (constraint === null) {
        return {
            ...provider,
            percent: null,
            state,
            meterState: UNAVAILABLE,
            styleClass: 'claudometer-provider-unavailable',
            opacity: DIM_OPACITY,
            accessibleName: `${provider.name} usage data unavailable`,
        };
    }

    let meterState = state;
    if (state === STALE) {
        if (constraint.percent >= 100)
            meterState = LIMIT_HIT;
        else if (constraint.percent >= criticalAt)
            meterState = CRITICAL;
        else if (constraint.percent >= warningAt)
            meterState = WARNING;
        else
            meterState = NORMAL;
    }

    let accessibleName = `${provider.name} usage: ` +
        `${Math.round(constraint.percent)} percent used`;
    if (state === STALE)
        accessibleName += `, data is ${formatAge(now - snapshot.fetchedAt)} old`;
    else if (constraint.resetsAt != null)
        accessibleName += resetClause(constraint, now, opts.clock24 ?? true);
    return {
        ...provider,
        percent: constraint.percent,
        state,
        meterState,
        styleClass: `claudometer-provider-${state}`,
        opacity: state === STALE ? DIM_OPACITY : 1,
        accessibleName,
    };
}

function multiProviderModel(snapshot, now, opts) {
    const items = PROVIDERS.map(provider => providerItem(
        provider, snapshot.providers?.[provider.id], now, opts));
    return {
        items,
        accessibleName: items.map(item => item.accessibleName).join('; '),
    };
}

export function indicatorModel(snapshot, now, opts = {}) {
    if (snapshot?.providers !== undefined)
        return multiProviderModel(snapshot, now, opts);
    const {
        displayMode = ICON_AND_PERCENT,
        headlineMetric = HEADLINE_AUTO,
        clock24 = true,
        warningAt = 80,
    } = opts;
    const state = classify(snapshot, now, opts);

    if (state === UNAVAILABLE) {
        return {
            labelText: null,
            styleClass: 'claudometer-unavailable',
            opacity: DIM_OPACITY,
            // §3.3 honesty rule: no number anywhere — not in the label,
            // not in the accessible name.
            accessibleName: 'Claude usage data unavailable',
            // Never hidden, even in percent-only mode: with no number to
            // show, the slashed meter is all that marks the state.
            iconVariant: 'meter-unavailable',
            iconPercent: null,
        };
    }

    const constraint = headlineOf(snapshot, headlineMetric);
    const name = windowName(constraint);
    let labelText, iconVariant, iconPercent, accessibleName;

    if (state === LIMIT_HIT) {
        // §3.3: at 100% the label swaps meaning from "how much used" to
        // "when am I back"; the hourglass signals the swap. A real
        // countdown overrides icon-only mode (UX-Q3 lean) — without a
        // reset time there is no countdown, so no override, and the
        // honest fallback label is the (true) 100%.
        const countdown = constraint.resetsAt == null
            ? null
            : formatCountdown(constraint.resetsAt - now);
        iconVariant = 'hourglass';
        iconPercent = null;
        accessibleName = `Claude usage: ${name} limit reached` +
            resetClause(constraint, now, clock24);
        if (countdown !== null)
            labelText = countdown;
        else
            labelText = displayMode === ICON_ONLY ? null : formatPercent(100);
    } else {
        // §3.3: warning/critical earn the `!` overlay; stale keeps the
        // *current* meter (overlay included) and signals staleness by
        // dimming, not by stripping state.
        iconVariant = constraint.percent >= warningAt ? 'meter-alert' : 'meter';
        iconPercent = constraint.percent;
        labelText = displayMode === ICON_ONLY
            ? null
            : formatPercent(constraint.percent);
        accessibleName =
            `Claude usage: ${Math.round(constraint.percent)} percent ` +
            `of ${name} limit used`;
        if (state === STALE) {
            // §8 stale qualifier; the reset clause is dropped — a stale
            // reset time may already have passed.
            accessibleName += `, data is ${formatAge(now - snapshot.fetchedAt)} old`;
        } else {
            accessibleName += resetClause(constraint, now, clock24);
        }
    }

    return {
        labelText,
        styleClass: `claudometer-${state}`,
        opacity: state === STALE ? DIM_OPACITY : 1,
        accessibleName,
        iconVariant: displayMode === PERCENT_ONLY ? null : iconVariant,
        iconPercent,
    };
}
