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

// §3.3 state, with the precedence the table implies: unavailable (no
// usable data) beats everything; stale (data older than staleAfterMs)
// beats every threshold state — a stale countdown or percent cannot be
// trusted; then limit-hit at 100, critical, warning, normal.
export function classify(snapshot, now, opts = {}) {
    const constraint = constraintOf(snapshot);
    if (constraint === null)
        return UNAVAILABLE;

    const {
        warningAt = 80,
        criticalAt = 95,
        staleAfterMs = DEFAULT_STALE_AFTER_MS,
    } = opts;

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
