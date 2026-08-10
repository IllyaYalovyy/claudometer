// RFC-002 Codex provider policy: query the documented App Server at the
// configured cadence, retain the last successful snapshot across transient
// failures, and stop repeated process attempts after three initial failures.
// Manual refresh re-arms that polite give-up.

import {fetchCodexSnapshot, defaultCodexConfig} from './codex_fetcher.js';

export const DEFAULT_CODEX_REFRESH_AFTER_MS = 60000;
export const MAX_CODEX_INEFFECTIVE_REFRESHES = 3;

export class CodexUsageSource {
    constructor({
        config = defaultCodexConfig(),
        refreshAfterMs = DEFAULT_CODEX_REFRESH_AFTER_MS,
        fetcher = fetchCodexSnapshot,
        warn = message => console.warn(message),
    } = {}) {
        this._config = config;
        this._refreshAfterMs = refreshAfterMs;
        this._fetcher = fetcher;
        this._warn = warn;
        this._lastGood = null;
        this._lastFailure = null;
        this._lastWarned = null;
        this._ineffectiveRefreshes = 0;
        this._lastRefreshFailed = false;
    }

    get lastRefreshFailed() {
        return this._lastRefreshFailed;
    }

    async fetch(now, {manual = false} = {}) {
        if (manual)
            this._ineffectiveRefreshes = 0;
        if (!this._wantsRefresh(now, manual))
            return this._lastGood ?? this._lastFailure;

        const snapshot = await this._fetcher(this._config, now);
        if (!('error' in snapshot)) {
            this._lastGood = snapshot;
            this._lastFailure = null;
            this._lastWarned = null;
            this._ineffectiveRefreshes = 0;
            this._lastRefreshFailed = false;
            return snapshot;
        }

        this._lastFailure = snapshot;
        this._lastRefreshFailed = true;
        this._reportFailure(snapshot);
        if (this._lastGood !== null)
            return this._lastGood;

        this._ineffectiveRefreshes++;
        if (this._ineffectiveRefreshes === MAX_CODEX_INEFFECTIVE_REFRESHES) {
            this._warn('Claudometer: Codex usage reads suspended after ' +
                `${MAX_CODEX_INEFFECTIVE_REFRESHES} failed attempts; ` +
                'manual refresh re-arms');
        }
        return snapshot;
    }

    _wantsRefresh(now, manual) {
        if (manual)
            return true;
        if (this._lastGood === null) {
            return this._ineffectiveRefreshes <
                MAX_CODEX_INEFFECTIVE_REFRESHES;
        }
        return now - this._lastGood.fetchedAt >= this._refreshAfterMs;
    }

    _reportFailure(snapshot) {
        const detail = [snapshot.error, snapshot.reason]
            .filter(Boolean).join(':');
        const key = `${detail}:${snapshot.command ?? ''}`;
        if (key === this._lastWarned)
            return;
        this._lastWarned = key;
        this._warn('Claudometer: Codex usage read failed' +
            `${detail === '' ? '' : ` (${detail})`}` +
            `${snapshot.command ? `; command: ${snapshot.command}` : ''}`);
    }
}
