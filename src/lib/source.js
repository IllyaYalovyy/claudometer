// The composed RFC-001 Option C data source: the ~/.claude.json cache is
// the only parse surface (fetcher.fetchSnapshot); the proven token-free
// CLI spawn (fetcher.refreshCache) only makes it fresh. This module owns
// the when-to-spawn policy the fetcher deliberately doesn't: spawn when
// the cache's own freshness stamp is older than the refresh threshold,
// when the file yielded no usable data, or when the user asked (manual
// refresh always spawns) — then re-read the file, because the spawn's
// stdout is a health signal, never a data source. No Shell imports;
// importable under plain `gjs -m`.
//
// G1 fail-closed rule (RFC-001 drift detection 2): the first MODEL_INVOKED
// verdict from a spawn permanently disables the refresh path for this
// source — degraded freshness is acceptable, spending tokens is not. The
// cache file remains served read-only. (Persisting the disable across
// sessions is the GSettings task, #11; until then it holds for the
// extension's lifetime.)

import {defaultConfig, fetchSnapshot, refreshCache, MODEL_INVOKED} from './fetcher.js';

// RFC-001: the staleness threshold that triggers a refresh spawn defaults
// to the UX §6 poll interval, which also spaces spawns at least one poll
// apart. (Distinct from derive.js's 3× DEFAULT_STALE_AFTER_MS, which is
// when unrefreshed data starts *looking* stale.)
export const DEFAULT_REFRESH_AFTER_MS = 60000;

export class UsageSource {
    // `config` is the fetcher config (filePath/refreshArgv/timeout), held
    // by reference and read per call, so a caller may swap the argv (a
    // future preference) without rebuilding the source.
    constructor({config = defaultConfig(),
        refreshAfterMs = DEFAULT_REFRESH_AFTER_MS} = {}) {
        this._config = config;
        this._refreshAfterMs = refreshAfterMs;
        this._refreshDisabled = false;
        this._lastWarned = null;
    }

    // Whether the G1 tripwire has fired and the CLI refresh path is off.
    get refreshDisabled() {
        return this._refreshDisabled;
    }

    // The Scheduler-shaped fetch: always resolves to a UsageSnapshot.
    async fetch(now, {manual = false} = {}) {
        const snapshot = await fetchSnapshot(this._config, now);
        if (!this._wantsRefresh(snapshot, now, manual))
            return snapshot;

        const result = await refreshCache(this._config);
        if (result.ok)
            this._lastWarned = null;
        else
            this._reportFailure(result);
        // Re-read regardless of the spawn verdict: only the file says
        // what the data now is (the CLI may have advanced it even when
        // its envelope looked unhealthy).
        return fetchSnapshot(this._config, now);
    }

    _wantsRefresh(snapshot, now, manual) {
        if (this._refreshDisabled)
            return false;
        if (manual || 'error' in snapshot)
            return true;
        return now - snapshot.fetchedAt > this._refreshAfterMs;
    }

    // Raw causes go to the journal, never to the UI (§4.5). Repeats of
    // the same failure are logged once — a broken refresh path must not
    // write a warning per poll tick.
    _reportFailure(result) {
        if (result.error === MODEL_INVOKED) {
            this._refreshDisabled = true;
            console.warn('Claudometer: refresh envelope could not prove ' +
                'zero model cost; permanently disabling the CLI refresh ' +
                'path (RFC-001 G1 tripwire)');
            return;
        }
        const key = `${result.error}:${result.reason ?? ''}`;
        if (key === this._lastWarned)
            return;
        this._lastWarned = key;
        console.warn(`Claudometer: cache refresh failed: ${result.error}` +
            `${result.reason ? ` (${result.reason})` : ''}`);
    }
}
