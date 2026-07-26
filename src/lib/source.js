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
// verdict from a spawn permanently disables the refresh path — degraded
// freshness is acceptable, spending tokens is not. The cache file remains
// served read-only. The disable persists across sessions through injected
// wiring (this module stays GSettings-free): the caller seeds the flag
// from the persisted `refresh-path-disabled` key via `refreshDisabled`
// and stores trips through `onRefreshDisabled`; re-enabling is only ever
// an explicit user action, arriving via setRefreshDisabled(false).
//
// Distinct from that tripwire is the #19 polite give-up: on a signed-out
// or API-key-only setup every spawn exits healthy without ever creating
// the cache key, so the error snapshot recurs forever. After
// MAX_INEFFECTIVE_REFRESHES such spawns the error path stops spawning and
// serves the file read only (VISION principle 2 — no eternal no-op
// subprocess loop). It re-arms without persistence: a manual refresh
// resets the counter, and a file that starts parsing again (the user
// signed in) never consults it — only error snapshots are gated.

import {defaultConfig, fetchSnapshot, refreshCache, MODEL_INVOKED} from './fetcher.js';

// RFC-001: the staleness threshold that triggers a refresh spawn defaults
// to the UX §6 poll interval, which also spaces spawns at least one poll
// apart. (Distinct from derive.js's 3× DEFAULT_STALE_AFTER_MS, which is
// when unrefreshed data starts *looking* stale.)
export const DEFAULT_REFRESH_AFTER_MS = 60000;

// #19 polite give-up: consecutive refresh spawns that still leave the
// file read in error before auto-spawning suspends (manual re-arms).
export const MAX_INEFFECTIVE_REFRESHES = 3;

export class UsageSource {
    // `config` is the fetcher config (filePath/refreshArgv/timeout), held
    // by reference and read per call, so a caller may swap the argv (a
    // future preference) without rebuilding the source.
    // `warn` is the journal sink (gjs's console.warn is unpatchable, so
    // tests inject their own to assert on the message).
    constructor({config = defaultConfig(),
        refreshAfterMs = DEFAULT_REFRESH_AFTER_MS,
        refreshDisabled = false,
        onRefreshDisabled = null,
        warn = message => console.warn(message)} = {}) {
        this._config = config;
        this._refreshAfterMs = refreshAfterMs;
        this._refreshDisabled = refreshDisabled;
        this._onRefreshDisabled = onRefreshDisabled;
        this._warn = warn;
        this._lastWarned = null;
        this._ineffectiveRefreshes = 0;
        this._lastRefreshFailed = false;
    }

    // Whether the most recent refresh spawn failed (#16). The §4.4 stale
    // footer may claim "last refresh failed" only on this evidence — old
    // data alone is not it: the CLI throttles rewrites of its cache, so a
    // healthy spawn routinely leaves the freshness stamp unchanged.
    // Fetches that spawn nothing leave the last outcome standing.
    get lastRefreshFailed() {
        return this._lastRefreshFailed;
    }

    // Whether the G1 tripwire has fired and the CLI refresh path is off.
    get refreshDisabled() {
        return this._refreshDisabled;
    }

    // Mirror of the persisted flag, driven by the caller on external
    // changes to the settings key. false re-arms the refresh path (and
    // the tripwire with it); RFC-001 requires that to be an explicit
    // user action, so nothing in this module ever calls it.
    setRefreshDisabled(value) {
        this._refreshDisabled = value;
    }

    // The Scheduler-shaped fetch: always resolves to a UsageSnapshot.
    async fetch(now, {manual = false} = {}) {
        // Manual re-arms the give-up: the user is asking, so the auto
        // path earns a fresh allowance of attempts too.
        if (manual)
            this._ineffectiveRefreshes = 0;
        const snapshot = await fetchSnapshot(this._config, now);
        if (!this._wantsRefresh(snapshot, now, manual))
            return snapshot;

        const result = await refreshCache(this._config);
        this._lastRefreshFailed = !result.ok;
        if (result.ok)
            this._lastWarned = null;
        else
            this._reportFailure(result);
        // Re-read regardless of the spawn verdict: only the file says
        // what the data now is (the CLI may have advanced it even when
        // its envelope looked unhealthy).
        const refreshed = await fetchSnapshot(this._config, now);
        this._countRefreshEffect(refreshed);
        return refreshed;
    }

    _wantsRefresh(snapshot, now, manual) {
        if (this._refreshDisabled)
            return false;
        if (manual)
            return true;
        // Only the error path is gated by the give-up: a cache that
        // parses again (the user signed in) spawns on staleness as
        // normal, which is exactly the file-changed re-arm.
        if ('error' in snapshot)
            return this._ineffectiveRefreshes < MAX_INEFFECTIVE_REFRESHES;
        return now - snapshot.fetchedAt > this._refreshAfterMs;
    }

    // A refresh was "ineffective" when the re-read after it still yields
    // an error snapshot — the spawn achieved nothing (the signed-out CLI
    // exits 0 without creating the cache key). Log the give-up once per
    // suspension, journal only (§4.5).
    _countRefreshEffect(snapshot) {
        if (!('error' in snapshot)) {
            this._ineffectiveRefreshes = 0;
            return;
        }
        this._ineffectiveRefreshes++;
        if (this._ineffectiveRefreshes === MAX_INEFFECTIVE_REFRESHES) {
            this._warn('Claudometer: refresh path suspended after ' +
                `${MAX_INEFFECTIVE_REFRESHES} ineffective attempts; ` +
                'manual refresh re-arms');
        }
    }

    // Raw causes go to the journal, never to the UI (§4.5). Repeats of
    // the same failure are logged once — a broken refresh path must not
    // write a warning per poll tick.
    _reportFailure(result) {
        if (result.error === MODEL_INVOKED) {
            this._refreshDisabled = true;
            this._onRefreshDisabled?.();
            this._warn('Claudometer: refresh envelope could not prove ' +
                'zero model cost; permanently disabling the CLI refresh ' +
                'path (RFC-001 G1 tripwire)');
            return;
        }
        const key = `${result.error}:${result.reason ?? ''}`;
        if (key === this._lastWarned)
            return;
        this._lastWarned = key;
        // Name the resolved command so a wrong or missing CLI path is
        // diagnosable from the journal alone (#18).
        this._warn(`Claudometer: cache refresh failed: ${result.error}` +
            `${result.reason ? ` (${result.reason})` : ''}` +
            `${result.command ? `; command: ${result.command}` : ''}`);
    }
}
