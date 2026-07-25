// Pure parser: raw ~/.claude.json text -> the UsageSnapshot display
// contract of designs/UX-DESIGN.md §2. No Shell imports; importable under
// plain `gjs -m`. The fetcher (RFC-001 Design) does only IO and hands the
// unparsed file text here, so this module owns every schema decision —
// including the strict drift tripwire: a wrong-typed consumed field means
// the CLI's internal schema drifted, and the whole payload is rejected as
// UNPARSEABLE rather than coerced or partially trusted. Windows that are
// simply absent, by contrast, yield a snapshot without those fields —
// never a fabricated 0 (UX §1 honesty rules).
//
// parseSnapshot(raw, now):
//   raw — string contents of ~/.claude.json
//   now — epoch ms; used as fetchedAt only for error snapshots, which have
//         no honest source timestamp (staleness is derived later from
//         fetchedAt by the caller, never decided here)
// Returns {fetchedAt, session?, week?, weekModel?, error?} where
// session/week are {percent, resetsAt}, weekModel entries add a `model`
// display name, resetsAt/fetchedAt are epoch ms.

// Failure taxonomy (RFC-001 Design). NOT_INSTALLED is never produced here —
// only the fetcher can observe a missing installation — but the constant
// lives with its siblings so all consumers share one vocabulary.
export const NOT_INSTALLED = 'not-installed';
export const NOT_AUTHENTICATED = 'not-authenticated';
export const UNPARSEABLE = 'unparseable';

// Window kinds this parser consumes; unknown kinds are skipped without
// validation so future CLI window types cannot break parsing (RFC-001
// forward compatibility).
const WINDOW_KINDS = new Set(['session', 'weekly_all', 'weekly_scoped']);

// Strict ISO 8601 with an explicit offset — the only reset-time format the
// cache has ever carried. Anything else (notably the CLI's human prose
// dates) is drift, not something to hand to a lenient Date.parse.
const RESETS_AT_RE =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Finite numbers are clamped into the displayable 0–100 range (the source
// can carry small rounding artifacts and overage values; the UI derives
// limit-hit at 100). Non-numbers are schema drift: null, never a guess.
function parsePercent(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return null;
    return Math.min(100, Math.max(0, value));
}

// -> epoch ms, or null on any deviation from the strict format. The
// fraction is normalized to exactly three digits so Date.parse only ever
// sees the spec-guaranteed date-time format, on every JS engine.
function parseResetsAt(value) {
    if (typeof value !== 'string')
        return null;
    const match = RESETS_AT_RE.exec(value);
    if (match === null)
        return null;
    const [, dateTime, fraction = '', offset] = match;
    const millis = fraction.padEnd(3, '0').slice(0, 3);
    const epochMs = Date.parse(`${dateTime}.${millis}${offset}`);
    return Number.isNaN(epochMs) ? null : epochMs;
}

export function parseSnapshot(raw, now) {
    const unparseable = {fetchedAt: now, error: UNPARSEABLE};

    if (typeof raw !== 'string')
        return unparseable;
    let root;
    try {
        root = JSON.parse(raw);
    } catch {
        return unparseable;
    }
    if (!isPlainObject(root))
        return unparseable;

    // Absent/null cache in an otherwise well-formed file is the signed-out
    // or API-key-only state (RFC-001 taxonomy), not a parse failure.
    const cache = root.cachedUsageUtilization;
    if (cache === undefined || cache === null)
        return {fetchedAt: now, error: NOT_AUTHENTICATED};
    if (!isPlainObject(cache))
        return unparseable;

    if (!Number.isInteger(cache.fetchedAtMs) || cache.fetchedAtMs <= 0)
        return unparseable;
    if (!isPlainObject(cache.utilization))
        return unparseable;
    const limits = cache.utilization.limits;
    if (!Array.isArray(limits))
        return unparseable;

    const snapshot = {fetchedAt: cache.fetchedAtMs};
    const weekModel = [];
    for (const limit of limits) {
        if (!isPlainObject(limit) || typeof limit.kind !== 'string')
            return unparseable;
        if (!WINDOW_KINDS.has(limit.kind))
            continue;
        const percent = parsePercent(limit.percent);
        const resetsAt = parseResetsAt(limit.resets_at);
        if (percent === null || resetsAt === null)
            return unparseable;
        if (limit.kind === 'session') {
            snapshot.session ??= {percent, resetsAt};
        } else if (limit.kind === 'weekly_all') {
            snapshot.week ??= {percent, resetsAt};
        } else {
            const model = limit.scope?.model?.display_name;
            if (typeof model !== 'string' || model === '')
                return unparseable;
            weekModel.push({model, percent, resetsAt});
        }
    }
    if (weekModel.length > 0)
        snapshot.weekModel = weekModel;
    return snapshot;
}
