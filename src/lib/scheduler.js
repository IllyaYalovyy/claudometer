// Refresh policy of designs/UX-DESIGN.md §6, split in two: a pure backoff
// state machine (no timers, no wall clock — fully unit-testable) and the
// thin Scheduler driver that wires it to GLib timeouts and wake signals.
// No Shell imports; importable under plain `gjs -m`.
//
// The scheduler never talks to the data source itself: it calls an
// injected `fetch(now) -> Promise<UsageSnapshot>` (composed elsewhere from
// fetcher.js, per RFC-001), so no code here can spend tokens. A fetch that
// resolves to an error snapshot — or breaks its never-reject contract —
// reaches the listener as an UNAVAILABLE-class snapshot and engages
// backoff; it never throws into the mainloop or stops the cadence.
import GLib from 'gi://GLib';

import {UNPARSEABLE} from './snapshot.js';

// UX §6: exponential backoff on failure, 1 → 2 → 5 min cap. Consecutive
// failure N waits ladder[N-1] (the last rung past the end).
export const BACKOFF_LADDER_SEC = [60, 120, 300];

// State for nextState: {baseSec, failures, delaySec}. delaySec is what the
// driver schedules next; failures counts consecutive error snapshots.
export function initialState(baseIntervalSec) {
    return {baseSec: baseIntervalSec, failures: 0, delaySec: baseIntervalSec};
}

// Events: 'success' (usable snapshot), 'failure' (error snapshot),
// 'manual' (user-initiated refresh — resets backoff per §6 before the
// fetch outcome is known). Backing off only ever slows down: a rung is
// never allowed below the configured base interval (a 10-min preference
// must not speed up to 1 min on failure).
export function nextState(state, event) {
    switch (event) {
    case 'success':
    case 'manual':
        return {...state, failures: 0, delaySec: state.baseSec};
    case 'failure': {
        const failures = state.failures + 1;
        const rung = BACKOFF_LADDER_SEC[
            Math.min(failures, BACKOFF_LADDER_SEC.length) - 1];
        return {...state, failures, delaySec: Math.max(state.baseSec, rung)};
    }
    default:
        throw new Error(`unknown scheduler event: ${event}`);
    }
}

// Live cadence change (§7 refresh interval applied without disable/
// enable): keep the failure count, recompute the delay for the new base.
// The same floor rule as nextState applies — an active backoff rung is
// never cut short, and the rung never dips below the new base.
export function rebasedState(state, baseSec) {
    if (state.failures === 0)
        return {baseSec, failures: 0, delaySec: baseSec};
    const rung = BACKOFF_LADDER_SEC[
        Math.min(state.failures, BACKOFF_LADDER_SEC.length) - 1];
    return {
        baseSec,
        failures: state.failures,
        delaySec: Math.max(baseSec, rung),
    };
}

// Menu-open policy (§6): refresh only when the last completed fetch is
// strictly older than maxAgeMs (or never happened). `fetchedAt` here is
// the driver's own completion time, not the payload's fetchedAtMs — the
// CLI's cache-write throttle makes the payload timestamp routinely older
// than any menu-open threshold, and keying on it would spawn a refresh on
// every open.
export function needsRefresh(fetchedAt, now, maxAgeMs) {
    return fetchedAt === null || now - fetchedAt > maxAgeMs;
}

// Default timer surface; injectable so driver tests control ticks
// deterministically.
const glibTimers = {
    addSeconds: (sec, cb) => GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT, sec, () => {
            cb();
            return GLib.SOURCE_REMOVE;
        }),
    remove: id => GLib.source_remove(id),
};

// The driver. Construction wires nothing; start()/stop() bracket every
// source and signal, so disable can never leave a zombie timer.
//
//   new Scheduler({fetch, onSnapshot, baseIntervalSec, wakeSources})
//
// - fetch(now, {manual}): injected async data source; resolves to a
//   UsageSnapshot (error snapshots included). `manual` marks fetches the
//   user initiated (refreshNow/maybeRefresh) so a source can skip its own
//   freshness gate — RFC-001's "manual refresh always spawns".
// - onSnapshot(snapshot): listener; called for every completed fetch.
// - wakeSources: unlock/resume triggers (§6) as GObject-style entries
//   {source, signal, wants?}. start() connects source.connect(signal, cb),
//   stop() disconnects. `wants(...args)` receives the signal's own args
//   (emitter stripped) and gates the refresh — e.g. Main.screenShield
//   {signal: 'locked-changed', wants: () => !Main.screenShield.locked},
//   or login1.js's PrepareForSleepAdapter gated on the resume (false)
//   edge. The Shell/DBus objects themselves are wired by the extension.
export class Scheduler {
    constructor({
        fetch,
        onSnapshot,
        baseIntervalSec = 60,
        wakeSources = [],
        now = () => Date.now(),
        timers = glibTimers,
    }) {
        this._fetch = fetch;
        this._onSnapshot = onSnapshot;
        this._baseSec = baseIntervalSec;
        this._wakeSources = wakeSources;
        this._now = now;
        this._timers = timers;

        this._running = false;
        this._timeoutId = 0;
        this._inFlight = false;
        this._refetchQueued = false;
        this._manualQueued = false;
        this._wakeIds = [];
        this._snapshot = null;
        this._fetchedAt = null;
    }

    // Latest delivered snapshot and the driver-side completion time of the
    // fetch that produced it (epoch ms) — the age needsRefresh keys on.
    get snapshot() {
        return this._snapshot;
    }

    get fetchedAt() {
        return this._fetchedAt;
    }

    start() {
        if (this._running)
            return;
        this._running = true;
        this._state = initialState(this._baseSec);
        this._wakeIds = this._wakeSources.map(({source, signal, wants}) => ({
            source,
            id: source.connect(signal, (_emitter, ...args) => {
                if (!wants || wants(...args))
                    this._refreshSoon();
            }),
        }));
        this._runFetch();
    }

    stop() {
        this._running = false;
        this._cancelTimer();
        for (const {source, id} of this._wakeIds)
            source.disconnect(id);
        this._wakeIds = [];
        this._refetchQueued = false;
        this._manualQueued = false;
    }

    // Live §7 interval change: no fetch, no backoff reset — the next tick
    // simply honors the new cadence. A pending tick is rescheduled; an
    // in-flight fetch is left alone (its completion schedules from the
    // rebased state).
    setBaseInterval(sec) {
        if (sec === this._baseSec)
            return;
        this._baseSec = sec;
        if (!this._running)
            return;
        this._state = rebasedState(this._state, sec);
        if (this._timeoutId !== 0) {
            this._cancelTimer();
            this._scheduleTick();
        }
    }

    // Manual refresh (§6): fetch immediately and reset the backoff. The
    // flag is consumed by the next fetch to *start*, so a manual refresh
    // queued behind an in-flight tick still reaches the source as manual.
    refreshNow() {
        if (!this._running)
            return;
        this._state = nextState(this._state, 'manual');
        this._manualQueued = true;
        this._refreshSoon();
    }

    // Menu-open refresh (§6): fetch only if the snapshot is older than
    // maxAgeMs. Returns whether a refresh was started. User-initiated, so
    // it resets backoff like refreshNow.
    maybeRefresh(maxAgeMs) {
        if (!this._running || !needsRefresh(this._fetchedAt, this._now(), maxAgeMs))
            return false;
        this.refreshNow();
        return true;
    }

    // Immediate out-of-cadence fetch (wake signal or manual): the pending
    // tick is superseded, not stacked on.
    _refreshSoon() {
        if (!this._running)
            return;
        this._cancelTimer();
        this._runFetch();
    }

    _cancelTimer() {
        if (this._timeoutId !== 0) {
            this._timers.remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    async _runFetch() {
        if (this._inFlight) {
            // A refresh landed while a fetch is running: run one more when
            // it completes rather than racing two fetches.
            this._refetchQueued = true;
            return;
        }
        this._inFlight = true;
        const manual = this._manualQueued;
        this._manualQueued = false;
        const startedAt = this._now();
        let snapshot;
        try {
            snapshot = await this._fetch(startedAt, {manual});
        } catch (e) {
            // The fetch contract is "never reject"; a rejection means the
            // source layer itself broke. Cause to the journal, an
            // UNAVAILABLE-class snapshot to the listener (RFC-001 §4.5).
            console.warn(`Claudometer: fetch failed unexpectedly: ${e.message}`);
            snapshot = {fetchedAt: startedAt, error: UNPARSEABLE};
        }
        this._inFlight = false;
        if (!this._running)
            return; // stopped mid-flight: discard, schedule nothing

        this._snapshot = snapshot;
        this._fetchedAt = this._now();
        this._state = nextState(this._state,
            'error' in snapshot ? 'failure' : 'success');
        try {
            this._onSnapshot(snapshot);
        } catch (e) {
            console.warn(`Claudometer: snapshot listener failed: ${e.message}`);
        }

        if (this._refetchQueued) {
            this._refetchQueued = false;
            this._runFetch();
            return;
        }
        this._scheduleTick();
    }

    _scheduleTick() {
        this._timeoutId = this._timers.addSeconds(this._state.delaySec, () => {
            this._timeoutId = 0;
            this._runFetch();
        });
    }
}
