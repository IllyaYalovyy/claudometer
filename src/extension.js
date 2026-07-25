import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

export default class ClaudometerExtension extends Extension {
    enable() {
        // Placeholder indicator; the real meter arrives with the UI tasks
        // (see designs/UX-DESIGN.md).
        this._indicator = new PanelMenu.Button(0.0, 'Claudometer', false);
        this._indicator.add_child(new St.Label({
            text: 'CM',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
