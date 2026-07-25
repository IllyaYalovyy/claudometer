import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClaudometerIndicator} from './indicator.js';

export default class ClaudometerExtension extends Extension {
    enable() {
        this._indicator = new ClaudometerIndicator();
        // No fetch has happened yet, and the honest rendering of "no data"
        // is the unavailable state (designs/UX-DESIGN.md §1); the data
        // wiring task replaces this with scheduler-driven updates.
        this._indicator.update(null, Date.now());
        // §3.2: right box, before the quick-settings aggregate.
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
