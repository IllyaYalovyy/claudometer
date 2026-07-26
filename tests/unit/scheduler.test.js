// Unit tests for src/lib/scheduler.js: the UX §6 refresh policy.
// The pure state machine (initialState/nextState/needsRefresh) is tested
// directly with no timers. The Scheduler driver is tested deterministically
// against injected fake timers and wake-signal emitters — every scheduled
// delay and every teardown is observable, no time-based waiting — plus one
// real-GLib-mainloop lifecycle test proving the default timeout_add_seconds
// wiring: start → tick fires the injected fetch → stop → no further ticks.
import GLib from 'gi://GLib';

import {test, assertEquals, assertThrows, runTests} from '../harness.js';
import {UNPARSEABLE} from '../../src/lib/snapshot.js';
import {
    BACKOFF_LADDER_SEC,
    initialState,
    nextState,
    needsRefresh,
    rebasedState,
    Scheduler,
} from '../../src/lib/scheduler.js';

// ---------------------------------------------------------------- helpers

// One mainloop iteration: resolves after every microtask queued before it
// (a settled fetch promise's continuation included) has run.
function settle() {
    return new Promise(resolve => {
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

// Mainloop-driven bounded poll for the real-timer test; a plain sleep would
// hide whether the tick ever fired.
function until(cond, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        let waited = 0;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (cond()) {
                resolve();
                return GLib.SOURCE_REMOVE;
            }
            waited += 100;
            if (waited >= timeoutMs) {
                reject(new Error(`timed out waiting for ${label}`));
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    });
}

function waitMs(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

// Deterministic stand-in for the GLib timer surface: scheduled delays are
// inspectable, ticks fire only on demand, removal is observable.
class FakeTimers {
    constructor() {
        this.pending = new Map();
        this._nextId = 1;
    }

    addSeconds(sec, cb) {
        const id = this._nextId++;
        this.pending.set(id, {sec, cb});
        return id;
    }

    remove(id) {
        this.pending.delete(id);
    }

    get delays() {
        return [...this.pending.values()].map(t => t.sec);
    }

    fireNext() {
        const [id, timer] = this.pending.entries().next().value;
        this.pending.delete(id);
        timer.cb();
        return timer.sec;
    }
}

// GObject-style signal source (connect(signal, cb) -> id / disconnect(id));
// handlers receive (emitter, ...args) exactly as GObject delivers them.
class FakeEmitter {
    constructor() {
        this._handlers = new Map();
        this._nextId = 1;
        this.disconnected = [];
    }

    connect(signal, cb) {
        const id = this._nextId++;
        this._handlers.set(id, {signal, cb});
        return id;
    }

    disconnect(id) {
        this.disconnected.push(id);
        this._handlers.delete(id);
    }

    emit(signal, ...args) {
        for (const handler of [...this._handlers.values()]) {
            if (handler.signal === signal)
                handler.cb(this, ...args);
        }
    }
}

const T0 = 1785000000000;

function okSnapshot(now) {
    return {fetchedAt: now, session: {percent: 27, resetsAt: now + 3600000}};
}

function errorSnapshot(now) {
    return {fetchedAt: now, error: 'refresh-failed'};
}

// Harness around a Scheduler with everything injected: fetch calls,
// emitted snapshots, scheduled delays, and the clock are all observable.
function makeScheduler({base = 60, wakeSources = [], onSnapshot} = {}) {
    const timers = new FakeTimers();
    const clock = {value: T0};
    const snapshots = [];
    const calls = [];
    const manualFlags = [];
    let fetchImpl = now => Promise.resolve(okSnapshot(now));
    const scheduler = new Scheduler({
        fetch: (now, opts) => {
            calls.push(now);
            manualFlags.push(opts?.manual === true);
            return fetchImpl(now);
        },
        onSnapshot: onSnapshot ?? (s => snapshots.push(s)),
        baseIntervalSec: base,
        wakeSources,
        now: () => clock.value,
        timers,
    });
    return {
        scheduler, timers, clock, snapshots, calls, manualFlags,
        setFetch: fn => {
            fetchImpl = fn;
        },
    };
}

// ------------------------------------------------- pure state machine

test('happy_cadence_stays_at_base_interval', () => {
    let state = initialState(60);
    assertEquals(state.delaySec, 60);
    for (let i = 0; i < 3; i++)
        state = nextState(state, 'success');
    assertEquals(state.delaySec, 60);
    assertEquals(state.failures, 0);
});

test('failures_walk_one_two_five_minutes_and_cap', () => {
    assertEquals(JSON.stringify(BACKOFF_LADDER_SEC),
        JSON.stringify([60, 120, 300]));
    let state = initialState(60);
    const walked = [];
    for (let i = 0; i < 4; i++) {
        state = nextState(state, 'failure');
        walked.push(state.delaySec);
    }
    assertEquals(JSON.stringify(walked), JSON.stringify([60, 120, 300, 300]),
        '1 → 2 → 5 min, capped');
    assertEquals(state.failures, 4);
});

test('success_after_failures_returns_to_base_interval', () => {
    let state = initialState(60);
    for (let i = 0; i < 3; i++)
        state = nextState(state, 'failure');
    state = nextState(state, 'success');
    assertEquals(state.delaySec, 60);
    assertEquals(state.failures, 0);
});

test('manual_refresh_resets_backoff', () => {
    let state = initialState(60);
    for (let i = 0; i < 3; i++)
        state = nextState(state, 'failure');
    state = nextState(state, 'manual');
    assertEquals(state.delaySec, 60);
    assertEquals(state.failures, 0);
});

test('backoff_never_schedules_below_the_configured_interval', () => {
    // A 10-min preference interval (UX §7) must not speed up to the 1-min
    // ladder rung on failure — backing off only ever slows down.
    let state = initialState(600);
    state = nextState(state, 'failure');
    assertEquals(state.delaySec, 600);
    // ...but a 30 s interval does back off to the 1-min rung.
    let fast = initialState(30);
    fast = nextState(fast, 'failure');
    assertEquals(fast.delaySec, 60);
});

test('unknown_event_is_an_explicit_error', () => {
    assertThrows(() => nextState(initialState(60), 'tick'));
});

test('rebase_moves_a_healthy_cadence_to_the_new_interval', () => {
    // §7 interval preference applied live: no failures means the next
    // delay is simply the new base.
    const state = rebasedState(initialState(60), 300);
    assertEquals(state.baseSec, 300);
    assertEquals(state.delaySec, 300);
    assertEquals(state.failures, 0);
});

test('rebase_keeps_the_backoff_rung_and_respects_the_new_floor', () => {
    let state = initialState(60);
    state = nextState(state, 'failure');
    state = nextState(state, 'failure');
    assertEquals(state.delaySec, 120, 'precondition: on the 2-min rung');
    const faster = rebasedState(state, 30);
    assertEquals(faster.delaySec, 120,
        'a shorter base does not cut an active backoff short');
    assertEquals(faster.failures, 2, 'failure count survives the rebase');
    const slower = rebasedState(state, 600);
    assertEquals(slower.delaySec, 600,
        'backoff never schedules below the new base');
});

test('needs_refresh_only_past_max_age', () => {
    assertEquals(needsRefresh(null, T0, 15000), true, 'never fetched');
    assertEquals(needsRefresh(T0, T0 + 14999, 15000), false, 'younger');
    assertEquals(needsRefresh(T0, T0 + 15000, 15000), false, 'exactly max age');
    assertEquals(needsRefresh(T0, T0 + 15001, 15000), true, 'older');
});

// ------------------------------------------------------------ driver

test('start_fetches_immediately_and_delivers_the_snapshot', async () => {
    const {scheduler, timers, clock, snapshots, calls} = makeScheduler();
    scheduler.start();
    await settle();
    assertEquals(calls.length, 1, 'one fetch on start');
    assertEquals(calls[0], clock.value, 'fetch receives now');
    assertEquals(snapshots.length, 1);
    assertEquals(snapshots[0].session.percent, 27);
    assertEquals(scheduler.snapshot, snapshots[0], 'driver holds the snapshot');
    assertEquals(scheduler.fetchedAt, clock.value, 'driver records fetch time');
    assertEquals(JSON.stringify(timers.delays), JSON.stringify([60]),
        'next tick at base cadence');
    scheduler.stop();
});

test('start_twice_does_not_double_the_cadence', async () => {
    const {scheduler, timers, calls} = makeScheduler();
    scheduler.start();
    scheduler.start();
    await settle();
    assertEquals(calls.length, 1);
    assertEquals(timers.pending.size, 1);
    scheduler.stop();
});

test('tick_fires_the_next_fetch_at_base_cadence', async () => {
    const {scheduler, timers, calls} = makeScheduler();
    scheduler.start();
    await settle();
    timers.fireNext();
    await settle();
    assertEquals(calls.length, 2, 'tick fetched again');
    assertEquals(JSON.stringify(timers.delays), JSON.stringify([60]));
    scheduler.stop();
});

test('driver_backs_off_on_error_snapshots_and_recovers', async () => {
    const {scheduler, timers, snapshots, calls, setFetch} = makeScheduler();
    setFetch(now => Promise.resolve(errorSnapshot(now)));
    scheduler.start();
    await settle();
    const scheduled = [timers.delays[0]];
    for (let i = 0; i < 3; i++) {
        timers.fireNext();
        await settle();
        scheduled.push(timers.delays[0]);
    }
    assertEquals(JSON.stringify(scheduled), JSON.stringify([60, 120, 300, 300]),
        'error snapshots walk the ladder');
    assertEquals(snapshots.length, 4, 'every error snapshot is delivered');
    assertEquals(snapshots[0].error, 'refresh-failed');

    setFetch(now => Promise.resolve(okSnapshot(now)));
    timers.fireNext();
    await settle();
    assertEquals(timers.delays[0], 60, 'success returns to base cadence');
    assertEquals(calls.length, 5);
    scheduler.stop();
});

test('fetch_rejection_surfaces_as_unavailable_snapshot_not_exception', async () => {
    const {scheduler, timers, clock, snapshots, setFetch} = makeScheduler();
    setFetch(() => Promise.reject(new Error('fetch contract broken')));
    scheduler.start();
    await settle();
    assertEquals(snapshots.length, 1, 'listener still hears about it');
    assertEquals(snapshots[0].error, UNPARSEABLE);
    assertEquals(snapshots[0].fetchedAt, clock.value);
    for (const key of ['session', 'week', 'weekModel'])
        assertEquals(key in snapshots[0], false, `no fabricated ${key}`);
    assertEquals(timers.delays[0], 60, 'cadence survives, backed off');
    scheduler.stop();
});

test('listener_exception_does_not_break_the_cadence', async () => {
    const {scheduler, timers} = makeScheduler({
        onSnapshot: () => {
            throw new Error('listener bug');
        },
    });
    scheduler.start();
    await settle();
    assertEquals(timers.pending.size, 1, 'next tick still scheduled');
    scheduler.stop();
});

test('stop_removes_the_pending_timer', async () => {
    const {scheduler, timers, calls} = makeScheduler();
    scheduler.start();
    await settle();
    assertEquals(timers.pending.size, 1);
    scheduler.stop();
    assertEquals(timers.pending.size, 0, 'no zombie timer after stop');
    assertEquals(calls.length, 1);
});

test('stop_during_inflight_fetch_discards_the_result', async () => {
    const {scheduler, timers, snapshots, setFetch} = makeScheduler();
    let resolveFetch;
    setFetch(() => new Promise(resolve => {
        resolveFetch = resolve;
    }));
    scheduler.start();
    scheduler.stop();
    resolveFetch(okSnapshot(T0));
    await settle();
    assertEquals(snapshots.length, 0, 'no emission after stop');
    assertEquals(timers.pending.size, 0, 'no reschedule after stop');
    assertEquals(scheduler.snapshot, null);
});

test('refresh_now_cancels_the_pending_timer_and_resets_backoff', async () => {
    const {scheduler, timers, calls, setFetch} = makeScheduler();
    setFetch(now => Promise.resolve(errorSnapshot(now)));
    scheduler.start();
    await settle();
    timers.fireNext();
    await settle();
    timers.fireNext();
    await settle();
    assertEquals(timers.delays[0], 300, 'deep in backoff');

    scheduler.refreshNow();
    assertEquals(calls.length, 4, 'manual refresh fetches immediately');
    await settle();
    // Still failing — but the manual reset means this is failure #1 again
    // (1 min), not failure #4 (5 min cap).
    assertEquals(JSON.stringify(timers.delays), JSON.stringify([60]),
        'backoff was reset by the manual refresh');
    scheduler.stop();
});

test('wake_signal_fires_an_immediate_refresh', async () => {
    const emitter = new FakeEmitter();
    const {scheduler, timers, calls} = makeScheduler({
        wakeSources: [{source: emitter, signal: 'wake-up'}],
    });
    scheduler.start();
    await settle();
    assertEquals(calls.length, 1);

    emitter.emit('wake-up');
    assertEquals(calls.length, 2, 'unlock/resume refreshes immediately');
    await settle();
    assertEquals(timers.pending.size, 1, 'single rescheduled tick, no pile-up');
    scheduler.stop();
});

test('wake_filter_gates_the_refresh', async () => {
    // Mirrors screenShield locked-changed: refresh on unlock, not on lock.
    const emitter = new FakeEmitter();
    const {scheduler, calls} = makeScheduler({
        wakeSources: [{
            source: emitter,
            signal: 'locked-changed',
            wants: locked => locked === false,
        }],
    });
    scheduler.start();
    await settle();
    emitter.emit('locked-changed', true);
    assertEquals(calls.length, 1, 'locking does not refresh');
    emitter.emit('locked-changed', false);
    assertEquals(calls.length, 2, 'unlocking refreshes');
    await settle();
    scheduler.stop();
});

test('stop_disconnects_every_wake_signal', async () => {
    const emitterA = new FakeEmitter();
    const emitterB = new FakeEmitter();
    const {scheduler, calls} = makeScheduler({
        wakeSources: [
            {source: emitterA, signal: 'wake-up'},
            {source: emitterB, signal: 'wake-up'},
        ],
    });
    scheduler.start();
    await settle();
    scheduler.stop();
    assertEquals(emitterA.disconnected.length, 1);
    assertEquals(emitterB.disconnected.length, 1);
    emitterA.emit('wake-up');
    emitterB.emit('wake-up');
    assertEquals(calls.length, 1, 'no fetch from a signal after stop');
});

test('maybe_refresh_fires_only_past_max_age', async () => {
    const {scheduler, clock, calls} = makeScheduler();
    assertEquals(scheduler.maybeRefresh(15000), false, 'not running yet');
    scheduler.start();
    await settle();
    assertEquals(calls.length, 1);

    clock.value = T0 + 15000;
    assertEquals(scheduler.maybeRefresh(15000), false, 'snapshot fresh enough');
    assertEquals(calls.length, 1);

    clock.value = T0 + 15001;
    assertEquals(scheduler.maybeRefresh(15000), true, 'past max age');
    assertEquals(calls.length, 2);
    await settle();
    scheduler.stop();
});

test('user_initiated_refreshes_are_flagged_manual_to_the_fetch', async () => {
    // RFC-001: "manual refresh always spawns" — the data source needs to
    // know a fetch is user-initiated so it can skip its own freshness
    // gate. Ticks and start-up fetches are not manual.
    const {scheduler, timers, clock, manualFlags} = makeScheduler();
    scheduler.start();
    await settle();
    assertEquals(manualFlags[0], false, 'start fetch is not manual');

    scheduler.refreshNow();
    await settle();
    assertEquals(manualFlags[1], true, 'refreshNow is manual');

    timers.fireNext();
    await settle();
    assertEquals(manualFlags[2], false, 'the next tick is not manual');

    clock.value += 20000;
    assertEquals(scheduler.maybeRefresh(15000), true);
    await settle();
    assertEquals(manualFlags[3], true, 'menu-open refresh is manual');
    scheduler.stop();
});

test('manual_pending_spans_refresh_now_until_its_snapshot_lands', async () => {
    // #20: the menu keys the refresh spinner on this — it must be true
    // exactly while a user-initiated fetch is pending or running, and
    // false for ticks/start fetches the user never asked for.
    const {scheduler, setFetch} = makeScheduler();
    let resolveFetch;
    setFetch(() => new Promise(resolve => {
        resolveFetch = resolve;
    }));
    scheduler.start();
    assertEquals(scheduler.manualPending, false,
        'the start fetch is not user-initiated');
    resolveFetch(okSnapshot(T0));
    await settle();

    scheduler.refreshNow();
    assertEquals(scheduler.manualPending, true,
        'true while the manual fetch runs');
    resolveFetch(okSnapshot(T0));
    await settle();
    assertEquals(scheduler.manualPending, false,
        'cleared once the manual snapshot landed');
    scheduler.stop();
});

test('manual_pending_survives_a_poll_snapshot_answering_first', async () => {
    // #20: a manual refresh clicked during an in-flight poll queues behind
    // it. The poll's completion must NOT read as the manual answer — the
    // pending flag holds through the poll snapshot and clears only on the
    // queued manual fetch's own snapshot.
    const pendingAtSnapshot = [];
    const {scheduler, setFetch} = makeScheduler({
        onSnapshot: () => pendingAtSnapshot.push(scheduler.manualPending),
    });
    const resolvers = [];
    setFetch(() => new Promise(resolve => resolvers.push(resolve)));
    scheduler.start();
    scheduler.refreshNow();
    assertEquals(scheduler.manualPending, true, 'queued behind the poll');
    resolvers[0](okSnapshot(T0));
    await settle();
    resolvers[1](okSnapshot(T0));
    await settle();
    assertEquals(JSON.stringify(pendingAtSnapshot),
        JSON.stringify([true, false]),
        'still pending at the poll snapshot, answered at the manual one');
    scheduler.stop();
});

test('stop_clears_manual_pending', async () => {
    const {scheduler, setFetch} = makeScheduler();
    setFetch(() => new Promise(() => {}));
    scheduler.start();
    scheduler.refreshNow();
    assertEquals(scheduler.manualPending, true);
    scheduler.stop();
    assertEquals(scheduler.manualPending, false,
        'a stopped scheduler owes nobody an answer');
});

test('manual_flag_survives_the_inflight_requeue', async () => {
    // A manual refresh landing during an in-flight tick queues one more
    // fetch — that queued fetch must still carry the manual flag.
    const {scheduler, manualFlags, setFetch} = makeScheduler();
    let resolveFetch;
    setFetch(() => new Promise(resolve => {
        resolveFetch = resolve;
    }));
    scheduler.start();
    scheduler.refreshNow();
    resolveFetch(okSnapshot(T0));
    await settle();
    assertEquals(manualFlags.length, 2, 'queued refetch ran');
    assertEquals(manualFlags[1], true, 'requeued fetch is still manual');
    scheduler.stop();
});

test('set_base_interval_reschedules_the_pending_tick', async () => {
    const {scheduler, timers, calls} = makeScheduler();
    scheduler.start();
    await settle();
    assertEquals(JSON.stringify(timers.delays), JSON.stringify([60]));

    scheduler.setBaseInterval(300);
    assertEquals(JSON.stringify(timers.delays), JSON.stringify([300]),
        'pending tick moved to the new cadence');
    assertEquals(calls.length, 1, 'an interval change is not a refresh');

    timers.fireNext();
    await settle();
    assertEquals(JSON.stringify(timers.delays), JSON.stringify([300]),
        'the new cadence persists across ticks');
    scheduler.stop();
});

test('set_base_interval_during_inflight_fetch_applies_to_the_next_tick', async () => {
    const {scheduler, timers, setFetch} = makeScheduler();
    let resolveFetch;
    setFetch(() => new Promise(resolve => {
        resolveFetch = resolve;
    }));
    scheduler.start();
    scheduler.setBaseInterval(120);
    resolveFetch(okSnapshot(T0));
    await settle();
    assertEquals(JSON.stringify(timers.delays), JSON.stringify([120]));
    scheduler.stop();
});

test('set_base_interval_same_value_leaves_the_pending_timer_untouched', async () => {
    const {scheduler, timers} = makeScheduler();
    scheduler.start();
    await settle();
    const [pendingId] = timers.pending.keys();
    scheduler.setBaseInterval(60);
    assertEquals([...timers.pending.keys()][0], pendingId,
        'no-op change does not reschedule');
    scheduler.stop();
});

test('set_base_interval_in_backoff_respects_the_new_floor', async () => {
    const {scheduler, timers, setFetch} = makeScheduler();
    setFetch(now => Promise.resolve(errorSnapshot(now)));
    scheduler.start();
    await settle();
    assertEquals(timers.delays[0], 60, 'precondition: failure #1 rung');
    scheduler.setBaseInterval(600);
    assertEquals(timers.delays[0], 600,
        'a 10-min preference must not keep the 1-min failure rung');
    scheduler.stop();
});

test('set_base_interval_while_stopped_applies_on_the_next_start', async () => {
    const {scheduler, timers} = makeScheduler();
    scheduler.setBaseInterval(300);
    scheduler.start();
    await settle();
    assertEquals(timers.delays[0], 300);
    scheduler.stop();
});

// ------------------------------------- real GLib mainloop lifecycle

test('glib_lifecycle_start_tick_fires_fetch_stop_no_further_ticks', async () => {
    let calls = 0;
    const scheduler = new Scheduler({
        fetch: now => {
            calls += 1;
            return Promise.resolve(okSnapshot(now));
        },
        onSnapshot: () => {},
        baseIntervalSec: 1,
    });
    scheduler.start();
    await settle();
    assertEquals(calls, 1, 'immediate fetch on start');
    // timeout_add_seconds may round to the next second boundary; allow a
    // generous bound, then require the tick actually happened.
    await until(() => calls >= 2, 3500, 'the first real tick');
    scheduler.stop();
    const after = calls;
    await waitMs(2500);
    assertEquals(calls, after, 'no ticks after stop');
});

runTests();
