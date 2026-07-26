// Resume-from-suspend wake source (UX §6): a resume that involves no lock
// screen never passes through the screen shield, so the unlock signal
// alone leaves the first post-resume glance stale until the next poll
// tick. This adapter bridges the system-bus org.freedesktop.login1
// PrepareForSleep signal into the Scheduler's GObject-style wake-source
// contract (connect(signal, cb) -> id / disconnect(id)); the resume-edge
// gating lives in the wake source's `wants`, like the shield wiring.
// No Shell imports; importable under plain `gjs -m`.
import Gio from 'gi://Gio';

export class PrepareForSleepAdapter {
    constructor(bus = Gio.DBus.system) {
        this._bus = bus;
        this._subscriptionIds = new Set();
    }

    // Returns the bus subscription id as the handler id. The handler is
    // called (adapter, sleeping) — emitter first, like GObject — with the
    // signal's `(b)` payload unpacked to a plain boolean (true = about to
    // suspend, false = resumed).
    connect(signal, cb) {
        if (signal !== 'prepare-for-sleep')
            throw new Error(`unknown login1 adapter signal: ${signal}`);
        const id = this._bus.signal_subscribe(
            'org.freedesktop.login1',
            'org.freedesktop.login1.Manager',
            'PrepareForSleep',
            '/org/freedesktop/login1',
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _name, params) => {
                const [sleeping] = params.deepUnpack();
                cb(this, sleeping);
            });
        this._subscriptionIds.add(id);
        return id;
    }

    disconnect(id) {
        if (!this._subscriptionIds.delete(id))
            throw new Error(`unknown login1 adapter handler id: ${id}`);
        this._bus.signal_unsubscribe(id);
    }
}
