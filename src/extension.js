import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClaudometerIndicator} from './indicator.js';
import {ClaudometerMenu} from './menu.js';
import {defaultConfig, fetchSnapshot} from './lib/fetcher.js';
import {Scheduler} from './lib/scheduler.js';

export default class ClaudometerExtension extends Extension {
    enable() {
        this._indicator = new ClaudometerIndicator();

        // The fetch is a read of the ~/.claude.json cache only — no CLI
        // spawn, so this path cannot cost tokens (VISION G1). Composing
        // the refresh trigger (fetcher.refreshCache) into the fetch is the
        // degraded-states wiring task (#10).
        const config = defaultConfig();
        this._scheduler = new Scheduler({
            fetch: now => fetchSnapshot(config, now),
            onSnapshot: snapshot => this._applySnapshot(snapshot),
        });
        this._menu = new ClaudometerMenu(this._indicator.menu, this._scheduler);

        // Honest pre-fetch rendering: the unavailable state, never 0%
        // (designs/UX-DESIGN.md §1); the first fetch lands right after
        // start().
        this._indicator.update(null, Date.now());
        // §3.2: right box, before the quick-settings aggregate.
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._scheduler.start();
    }

    disable() {
        this._scheduler?.stop();
        this._scheduler = null;
        this._menu?.destroy();
        this._menu = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    _applySnapshot(snapshot) {
        const now = Date.now();
        this._indicator.update(snapshot, now);
        this._menu.update(snapshot, now);
    }
}
