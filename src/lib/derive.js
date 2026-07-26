// Pure decision core: UsageSnapshot (designs/UX-DESIGN.md §2) -> the
// constraint window and the indicator state of §3.3. No Shell imports;
// importable under plain `gjs -m`.

export const NORMAL = 'normal';
export const WARNING = 'warning';
export const CRITICAL = 'critical';
export const LIMIT_HIT = 'limit-hit';
export const STALE = 'stale';
export const UNAVAILABLE = 'unavailable';

// 3x the §6 default 60 s poll cadence; callers with a configured interval
// pass their own staleAfterMs. Exported so format.js's freshness footer
// flips to its stale wording at the same age classify() flips to STALE.
export const DEFAULT_STALE_AFTER_MS = 3 * 60000;

// The window the user will hit first: highest percent across session, week,
// and per-model weekly entries, as {kind, percent, resetsAt, model?}. Ties
// break toward the earlier window in that fixed order (strict `>` below),
// so the headline cannot flap between near-equal windows (§7 pinning
// rationale). Null when the snapshot has no windows — that is the
// unavailable state, never a fabricated 0 (§1 honesty rules).
export function constraintOf(snapshot) {
    if (snapshot === null || typeof snapshot !== 'object')
        return null;
    const windows = [];
    if (snapshot.session)
        windows.push({kind: 'session', ...snapshot.session});
    if (snapshot.week)
        windows.push({kind: 'week', ...snapshot.week});
    for (const entry of snapshot.weekModel ?? [])
        windows.push({kind: 'weekModel', ...entry});

    let constraint = null;
    for (const window of windows) {
        if (constraint === null || window.percent > constraint.percent)
            constraint = window;
    }
    return constraint;
}

// §7 "Headline metric" preference values: auto headlines the constraint;
// session/week pin the headline to that window so it cannot flap between
// near-equal windows. Stored verbatim in the `headline-metric` key.
export const HEADLINE_AUTO = 'auto';
export const HEADLINE_SESSION = 'session';
export const HEADLINE_WEEK = 'week';

// The window the panel headlines: the pinned window when the preference
// names one the snapshot actually has, otherwise the constraint. Pinning
// picks among real windows (§1 honesty) — a pin on an absent window falls
// back rather than fabricating, and the accessible name always names the
// window shown.
export function headlineOf(snapshot, metric = HEADLINE_AUTO) {
    if (snapshot !== null && typeof snapshot === 'object') {
        if (metric === HEADLINE_SESSION && snapshot.session)
            return {kind: 'session', ...snapshot.session};
        if (metric === HEADLINE_WEEK && snapshot.week)
            return {kind: 'week', ...snapshot.week};
    }
    return constraintOf(snapshot);
}

// §3.3 state, with the precedence the table implies: unavailable (no
// usable data) beats everything; stale (data older than staleAfterMs)
// beats every threshold state — a stale countdown or percent cannot be
// trusted; then limit-hit at 100, critical, warning, normal. The state
// follows the §7 headline pin: a user pinned to one window chose not to
// be alerted for the others.
export function classify(snapshot, now, opts = {}) {
    const {
        headlineMetric = HEADLINE_AUTO,
        warningAt = 80,
        criticalAt = 95,
        staleAfterMs = DEFAULT_STALE_AFTER_MS,
    } = opts;
    const constraint = headlineOf(snapshot, headlineMetric);
    if (constraint === null)
        return UNAVAILABLE;

    if (now - snapshot.fetchedAt > staleAfterMs)
        return STALE;
    if (constraint.percent >= 100)
        return LIMIT_HIT;
    if (constraint.percent >= criticalAt)
        return CRITICAL;
    if (constraint.percent >= warningAt)
        return WARNING;
    return NORMAL;
}
