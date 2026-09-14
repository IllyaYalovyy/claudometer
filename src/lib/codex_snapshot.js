// Pure parser for RFC-002's documented Codex App Server
// account/rateLimits/read result. No Shell imports; importable under plain
// `gjs -m`. The parser retains only limit/access metadata used by the display
// and rejects a wrong-typed consumed field rather than fabricating a partial
// reading.

import {NOT_AUTHENTICATED, UNPARSEABLE} from './snapshot.js';

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorSnapshot(now, error = UNPARSEABLE) {
    return {fetchedAt: now, error};
}

function parseWindow(value, bucket, slot) {
    if (!isPlainObject(value))
        return null;
    const {usedPercent, windowDurationMins, resetsAt} = value;
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent))
        return null;
    if (windowDurationMins !== null && windowDurationMins !== undefined &&
        (typeof windowDurationMins !== 'number' ||
         !Number.isFinite(windowDurationMins) || windowDurationMins <= 0))
        return null;
    if (resetsAt !== null && resetsAt !== undefined &&
        (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) ||
         resetsAt <= 0))
        return null;
    return {
        limitId: bucket.limitId,
        ...(bucket.limitName === null ? {} : {limitName: bucket.limitName}),
        slot,
        percent: Math.min(100, Math.max(0, usedPercent)),
        ...(windowDurationMins == null ? {} : {durationMins: windowDurationMins}),
        // App Server timestamps are Unix seconds; the rest of Claudometer's
        // display contract uses epoch milliseconds.
        ...(resetsAt == null ? {} : {resetsAt: Math.round(resetsAt * 1000)}),
        ...(bucket.reachedType === null
            ? {}
            : {reachedType: bucket.reachedType}),
    };
}

function parseBucket(value, fallbackId = null) {
    if (!isPlainObject(value))
        return null;
    const limitId = value.limitId ?? fallbackId;
    if (typeof limitId !== 'string' || limitId === '')
        return null;
    const limitName = value.limitName ?? null;
    if (limitName !== null &&
        (typeof limitName !== 'string' || limitName === ''))
        return null;
    const reachedType = value.rateLimitReachedType ?? null;
    if (reachedType !== null &&
        (typeof reachedType !== 'string' || reachedType === ''))
        return null;
    const bucket = {limitId, limitName, reachedType};
    const windows = [];
    for (const slot of ['primary', 'secondary']) {
        const raw = value[slot];
        if (raw === null || raw === undefined)
            continue;
        const window = parseWindow(raw, bucket, slot);
        if (window === null)
            return null;
        windows.push(window);
    }
    return {...bucket, windows};
}

function parseOrdinaryUsageAllowed(result) {
    if (!Object.hasOwn(result, 'ordinaryUsageAllowed'))
        return {};
    const value = result.ordinaryUsageAllowed;
    if (value !== null && typeof value !== 'boolean')
        return null;
    return {ordinaryUsageAllowed: value};
}

function parseResetCredits(result) {
    const value = result.rateLimitResetCredits;
    if (value === null || value === undefined)
        return {};
    if (!isPlainObject(value) ||
        !Number.isSafeInteger(value.availableCount) ||
        value.availableCount < 0)
        return null;
    return {resetCreditsAvailable: value.availableCount};
}

// `result` is the value inside the matching JSON-RPC response. The
// multi-bucket view wins when non-empty; `rateLimits` is only its
// backward-compatible projection and displaying both would duplicate quota.
export function parseCodexRateLimits(result, now) {
    if (!isPlainObject(result) || !Number.isFinite(now))
        return errorSnapshot(now);

    const access = parseOrdinaryUsageAllowed(result);
    const resetCredits = parseResetCredits(result);
    if (access === null || resetCredits === null)
        return errorSnapshot(now);

    let entries;
    const byId = result.rateLimitsByLimitId;
    if (byId !== null && byId !== undefined && !isPlainObject(byId))
        return errorSnapshot(now);
    const hasMultiBucketView = isPlainObject(byId) &&
        Object.keys(byId).length > 0;
    if (hasMultiBucketView) {
        entries = Object.entries(byId);
    } else if (result.rateLimits !== null &&
               result.rateLimits !== undefined) {
        // The protocol allows a null id on the legacy projection; it is still
        // the main Codex bucket by definition.
        entries = [['codex', result.rateLimits]];
    } else {
        return errorSnapshot(now, NOT_AUTHENTICATED);
    }

    const buckets = [];
    for (const [fallbackId, rawBucket] of entries) {
        const parsed = parseBucket(rawBucket, fallbackId);
        if (parsed === null)
            return errorSnapshot(now);
        buckets.push(parsed);
    }

    // The backward-compatible projection identifies ordinary included usage.
    // Prefer its explicit id, then the documented `codex` id, then an
    // unlabelled bucket for older servers. Never let a named model bucket
    // become the provider-level meter merely because it arrived first.
    const rawMain = result.rateLimits;
    if (rawMain !== null && rawMain !== undefined && !isPlainObject(rawMain))
        return errorSnapshot(now);
    const explicitMainId = rawMain?.limitId;
    if (explicitMainId !== null && explicitMainId !== undefined &&
        (typeof explicitMainId !== 'string' || explicitMainId === ''))
        return errorSnapshot(now);
    let mainLimitId = explicitMainId ?? null;
    if (mainLimitId === null ||
        !buckets.some(bucket => bucket.limitId === mainLimitId)) {
        mainLimitId = buckets.find(bucket => bucket.limitId === 'codex')
            ?.limitId ??
            buckets.find(bucket => bucket.limitName === null)?.limitId ??
            buckets[0]?.limitId ?? null;
    }
    if (mainLimitId === null)
        return errorSnapshot(now, NOT_AUTHENTICATED);

    // App Server maps do not promise user-facing order. Keep the main bucket
    // first, then unlabelled compatibility buckets, then named model buckets.
    buckets.sort((a, b) => {
        const rank = bucket => bucket.limitId === mainLimitId
            ? 0
            : bucket.limitName === null ? 1 : 2;
        return rank(a) - rank(b);
    });
    const windows = buckets.flatMap(bucket => bucket.windows);
    if (windows.length === 0)
        return errorSnapshot(now, NOT_AUTHENTICATED);
    return {
        fetchedAt: now,
        mainLimitId,
        windows,
        ...access,
        ...resetCredits,
    };
}
