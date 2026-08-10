// Pure parser for RFC-002's documented Codex App Server
// account/rateLimits/read result. No Shell imports; importable under plain
// `gjs -m`. The parser retains only quota-window metadata and rejects a
// wrong-typed consumed field rather than fabricating a partial reading.

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
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) ||
        typeof windowDurationMins !== 'number' ||
        !Number.isFinite(windowDurationMins) || windowDurationMins <= 0 ||
        typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) ||
        resetsAt <= 0)
        return null;
    return {
        limitId: bucket.limitId,
        ...(bucket.limitName === null ? {} : {limitName: bucket.limitName}),
        slot,
        percent: Math.min(100, Math.max(0, usedPercent)),
        durationMins: windowDurationMins,
        // App Server timestamps are Unix seconds; the rest of Claudometer's
        // display contract uses epoch milliseconds.
        resetsAt: Math.round(resetsAt * 1000),
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
    const bucket = {limitId, limitName};
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
    return windows;
}

// `result` is the value inside the matching JSON-RPC response. The
// multi-bucket view wins when non-empty; `rateLimits` is only its
// backward-compatible projection and displaying both would duplicate quota.
export function parseCodexRateLimits(result, now) {
    if (!isPlainObject(result) || !Number.isFinite(now))
        return errorSnapshot(now);

    let entries;
    const byId = result.rateLimitsByLimitId;
    if (byId !== null && byId !== undefined && !isPlainObject(byId))
        return errorSnapshot(now);
    if (isPlainObject(byId) && Object.keys(byId).length > 0) {
        entries = Object.entries(byId);
        // General/unlabelled Codex quota first, then model-specific buckets.
        // App Server maps do not promise a user-facing order, while the menu
        // should not jump when backend insertion order changes.
        entries.sort(([, a], [, b]) =>
            (a?.limitName == null ? 0 : 1) - (b?.limitName == null ? 0 : 1));
    } else if (result.rateLimits !== null &&
               result.rateLimits !== undefined) {
        entries = [[null, result.rateLimits]];
    } else {
        return errorSnapshot(now, NOT_AUTHENTICATED);
    }

    const windows = [];
    for (const [fallbackId, rawBucket] of entries) {
        const parsed = parseBucket(rawBucket, fallbackId);
        if (parsed === null)
            return errorSnapshot(now);
        windows.push(...parsed);
    }
    if (windows.length === 0)
        return errorSnapshot(now, NOT_AUTHENTICATED);
    return {fetchedAt: now, windows};
}
