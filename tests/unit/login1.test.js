// Unit tests for src/lib/login1.js: the login1 PrepareForSleep adapter —
// the UX §6 resume-from-suspend wake source for resumes that involve no
// lock screen. The adapter is tested against a fake system bus whose
// deliveries carry a real `(b)` GVariant payload, exactly as GDBus hands
// it to a signal_subscribe callback; one integration test composes the
// adapter with a real Scheduler to prove the resume edge fetches
// immediately and stop() tears the bus subscription down.
import GLib from 'gi://GLib';

import {test, assertEquals, assertThrows, runTests} from '../harness.js';
import {PrepareForSleepAdapter} from '../../src/lib/login1.js';
import {Scheduler} from '../../src/lib/scheduler.js';

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

// Deterministic stand-in for the Scheduler's timer surface (as in
// scheduler.test.js): nothing fires unless asked, removal is observable.
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
}

// Fake Gio.DBusConnection covering the two calls the adapter makes.
// Ids start away from 1 so an adapter returning its own counter instead
// of the bus id cannot pass by coincidence.
class FakeSystemBus {
    constructor() {
        this.subscriptions = new Map();
        this.unsubscribed = [];
        this._nextId = 101;
    }

    signal_subscribe(sender, iface, member, path, arg0, flags, cb) {
        const id = this._nextId++;
        this.subscriptions.set(id, {sender, iface, member, path, arg0, flags, cb});
        return id;
    }

    signal_unsubscribe(id) {
        this.unsubscribed.push(id);
        this.subscriptions.delete(id);
    }

    // Deliver PrepareForSleep as GDBus does: (connection, senderName,
    // objectPath, interfaceName, signalName, parameters-as-GVariant).
    emitPrepareForSleep(sleeping) {
        for (const {cb} of [...this.subscriptions.values()]) {
            cb(this, ':1.7', '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager', 'PrepareForSleep',
                new GLib.Variant('(b)', [sleeping]));
        }
    }
}

const T0 = 1785000000000;

// ------------------------------------------------------------- adapter

test('connect_subscribes_to_login1_prepare_for_sleep', () => {
    const bus = new FakeSystemBus();
    const adapter = new PrepareForSleepAdapter(bus);
    adapter.connect('prepare-for-sleep', () => {});
    assertEquals(bus.subscriptions.size, 1, 'one bus subscription');
    const sub = [...bus.subscriptions.values()][0];
    assertEquals(sub.sender, 'org.freedesktop.login1');
    assertEquals(sub.iface, 'org.freedesktop.login1.Manager');
    assertEquals(sub.member, 'PrepareForSleep');
    assertEquals(sub.path, '/org/freedesktop/login1');
});

test('handler_receives_the_unpacked_sleeping_flag', () => {
    const bus = new FakeSystemBus();
    const adapter = new PrepareForSleepAdapter(bus);
    const received = [];
    adapter.connect('prepare-for-sleep',
        (emitter, sleeping) => received.push({emitter, sleeping}));

    bus.emitPrepareForSleep(true);
    bus.emitPrepareForSleep(false);
    assertEquals(received.length, 2);
    assertEquals(received[0].sleeping, true, 'suspend edge is a plain boolean');
    assertEquals(received[1].sleeping, false, 'resume edge is a plain boolean');
    // GObject handler shape: the emitter comes first, so the Scheduler's
    // `(_emitter, ...args)` strip leaves `wants(sleeping)`.
    assertEquals(received[0].emitter, adapter);
});

test('disconnect_unsubscribes_the_bus_subscription', () => {
    const bus = new FakeSystemBus();
    const adapter = new PrepareForSleepAdapter(bus);
    let calls = 0;
    const id = adapter.connect('prepare-for-sleep', () => {
        calls += 1;
    });
    adapter.disconnect(id);
    assertEquals(bus.subscriptions.size, 0, 'no live subscription remains');
    assertEquals(bus.unsubscribed.length, 1, 'released via signal_unsubscribe');
    bus.emitPrepareForSleep(false);
    assertEquals(calls, 0, 'no delivery after disconnect');
});

test('unknown_signal_or_handler_id_is_an_explicit_error', () => {
    const bus = new FakeSystemBus();
    const adapter = new PrepareForSleepAdapter(bus);
    assertThrows(() => adapter.connect('locked-changed', () => {}));
    assertEquals(bus.subscriptions.size, 0, 'bad connect leaks no subscription');
    assertThrows(() => adapter.disconnect(42));
    assertEquals(bus.unsubscribed.length, 0, 'bad disconnect touches no bus id');
});

// ------------------------------------------- composed with the Scheduler

test('resume_edge_refreshes_immediately_suspend_edge_does_not', async () => {
    const bus = new FakeSystemBus();
    const adapter = new PrepareForSleepAdapter(bus);
    const timers = new FakeTimers();
    const calls = [];
    const scheduler = new Scheduler({
        fetch: now => {
            calls.push(now);
            return Promise.resolve(
                {fetchedAt: now, session: {percent: 27, resetsAt: now + 3600000}});
        },
        onSnapshot: () => {},
        baseIntervalSec: 60,
        // The extension's wiring: the adapter forwards both edges, `wants`
        // gates the refresh to resume only.
        wakeSources: [{
            source: adapter,
            signal: 'prepare-for-sleep',
            wants: sleeping => !sleeping,
        }],
        now: () => T0,
        timers,
    });
    scheduler.start();
    await settle();
    assertEquals(calls.length, 1, 'start fetch only');

    bus.emitPrepareForSleep(true);
    assertEquals(calls.length, 1, 'going to sleep does not refresh');

    bus.emitPrepareForSleep(false);
    assertEquals(calls.length, 2, 'resume refreshes immediately');
    await settle();

    scheduler.stop();
    assertEquals(bus.subscriptions.size, 0, 'stop tears down the subscription');
    bus.emitPrepareForSleep(false);
    assertEquals(calls.length, 2, 'no fetch from a resume after stop');
});

runTests();
