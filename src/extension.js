import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClaudometerIndicator} from './indicator.js';
import {ClaudometerMenu} from './menu.js';
import {PrepareForSleepAdapter} from './lib/login1.js';
import {UsageSource} from './lib/source.js';
import {Scheduler} from './lib/scheduler.js';
import {
    displayOptions,
    normalizeHeadlineMetric,
    normalizeIndicatorStyle,
    normalizeRefreshInterval,
    normalizeThresholds,
} from './lib/settings_model.js';

// The §7 keys the extension re-reads live; every change re-renders the
// current snapshot (and rebases the scheduler) without disable/enable.
const SETTINGS_KEYS = [
    'indicator-style',
    'headline-metric',
    'warning-percent',
    'critical-percent',
    'refresh-interval-seconds',
];

export default class ClaudometerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // §4.3: times honor the system 12/24-hour clock setting.
        this._interfaceSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });
        this._clockFormatId = this._interfaceSettings.connect(
            'changed::clock-format', () => this._onSettingsChanged());
        const prefs = this._readPrefs();
        this._opts = displayOptions(prefs);

        this._indicator = new ClaudometerIndicator();

        // The RFC-001 Option C source: the ~/.claude.json cache is the
        // only parse surface; the proven token-free CLI spawn only
        // refreshes it, behind the source's G1 tripwire (VISION G1).
        // The tripwire's disable persists across sessions in the
        // refresh-path-disabled key; RFC-001 allows re-enabling only by
        // explicit user action (a gsettings write, mirrored into the
        // source by the changed:: handler below).
        this._source = new UsageSource({
            refreshDisabled: this._settings.get_boolean('refresh-path-disabled'),
            onRefreshDisabled: () =>
                this._settings?.set_boolean('refresh-path-disabled', true),
        });
        this._resumeAdapter = new PrepareForSleepAdapter();
        this._scheduler = new Scheduler({
            fetch: (now, opts) => this._source.fetch(now, opts),
            onSnapshot: snapshot => this._applySnapshot(snapshot),
            baseIntervalSec: prefs.refreshIntervalSec,
            // §6: refresh on session unlock and on resume from suspend —
            // the first glance after coming back must not be stale. Both
            // are needed: a lock-screen resume fires only the shield
            // signal, a lockless resume only login1's false edge.
            wakeSources: [{
                source: Main.screenShield,
                signal: 'locked-changed',
                wants: () => !Main.screenShield.locked,
            }, {
                source: this._resumeAdapter,
                signal: 'prepare-for-sleep',
                wants: sleeping => !sleeping,
            }],
        });
        this._menu = new ClaudometerMenu(this._indicator.menu, this._scheduler);
        this._settingsIds = SETTINGS_KEYS.map(key =>
            this._settings.connect(`changed::${key}`,
                () => this._onSettingsChanged()));
        // Not a §7 display key: mirror the persisted tripwire flag into
        // the source. A user's `false` write re-arms the refresh path;
        // the extension's own `true` write on a trip echoes back as a
        // no-op (the source is already disabled).
        this._settingsIds.push(this._settings.connect(
            'changed::refresh-path-disabled',
            () => this._source.setRefreshDisabled(
                this._settings.get_boolean('refresh-path-disabled'))));

        // Honest pre-fetch rendering: the unavailable state, never 0%
        // (designs/UX-DESIGN.md §1); the first fetch lands right after
        // start().
        this._applySnapshot(null);
        // §3.2: right box, before the quick-settings aggregate.
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._scheduler.start();
    }

    disable() {
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = null;
        this._settings = null;
        if (this._clockFormatId) {
            this._interfaceSettings.disconnect(this._clockFormatId);
            this._clockFormatId = null;
        }
        this._interfaceSettings = null;
        // stop() disconnects every wake source, which for the resume
        // adapter releases its system-bus subscription.
        this._scheduler?.stop();
        this._scheduler = null;
        this._resumeAdapter = null;
        this._source = null;
        this._menu?.destroy();
        this._menu = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    // Every read goes through the settings_model normalizers: the schema
    // enforces per-key ranges, but not the warning<critical rule or the
    // discrete interval set — a CLI write can violate both.
    _readPrefs() {
        return {
            indicatorStyle: normalizeIndicatorStyle(
                this._settings.get_string('indicator-style')),
            headlineMetric: normalizeHeadlineMetric(
                this._settings.get_string('headline-metric')),
            ...normalizeThresholds({
                warningPercent: this._settings.get_int('warning-percent'),
                criticalPercent: this._settings.get_int('critical-percent'),
            }),
            refreshIntervalSec: normalizeRefreshInterval(
                this._settings.get_int('refresh-interval-seconds')),
            clock24:
                this._interfaceSettings.get_string('clock-format') === '24h',
        };
    }

    // §7 rationale: changes apply live. Rebuild the option bags, move the
    // scheduler's cadence (the stale threshold follows as 3× the interval
    // inside displayOptions), and re-render the snapshot already on screen.
    _onSettingsChanged() {
        const prefs = this._readPrefs();
        this._opts = displayOptions(prefs);
        this._scheduler.setBaseInterval(prefs.refreshIntervalSec);
        this._applySnapshot(this._scheduler.snapshot);
    }

    _applySnapshot(snapshot) {
        const now = Date.now();
        // §4.4/#16: the footer's failure clause follows the source's real
        // spawn outcome, not the data's age.
        const opts = {
            ...this._opts,
            lastRefreshFailed: this._source.lastRefreshFailed,
        };
        this._indicator.update(snapshot, now, opts);
        this._menu.update(snapshot, now, opts);
    }
}
