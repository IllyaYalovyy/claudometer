// Panel indicator widget (designs/UX-DESIGN.md §3): a PanelMenu.Button
// that applies the pure render model from lib/indicator_model.js. All
// display decisions live in the model; this class only maps the model onto
// St properties, so it stays too thin to need widget-level tests.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {indicatorModel} from './lib/indicator_model.js';

// Stand-in symbolic icons until the custom gauge icon task lands
// (§3.1 — a separate task draws claudometer-symbolic.svg and friends).
const VARIANT_ICONS = {
    'meter': 'utilities-system-monitor-symbolic',
    'meter-alert': 'dialog-warning-symbolic',
    'hourglass': 'alarm-symbolic',
    'meter-unavailable': 'action-unavailable-symbolic',
};

export const ClaudometerIndicator = GObject.registerClass(
class ClaudometerIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Claudometer', false);
        this._stateClass = null;

        const box = new St.BoxLayout({
            style_class: 'panel-status-indicators-box',
        });
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);
    }

    // Apply a fresh render model. `opts` is the indicator_model options
    // bag (displayMode, thresholds, clock24, staleAfterMs) — preferences
    // arrive as args, per the design's pure-model contract.
    update(snapshot, now, opts = {}) {
        const model = indicatorModel(snapshot, now, opts);

        this._icon.visible = model.iconVariant !== null;
        if (model.iconVariant !== null)
            this._icon.icon_name = VARIANT_ICONS[model.iconVariant];

        this._label.visible = model.labelText !== null;
        this._label.text = model.labelText ?? '';

        if (this._stateClass !== model.styleClass) {
            if (this._stateClass !== null)
                this.remove_style_class_name(this._stateClass);
            this.add_style_class_name(model.styleClass);
            this._stateClass = model.styleClass;
        }

        // §3.3 dimming for stale/unavailable; St opacity is 0-255.
        this.opacity = Math.round(model.opacity * 255);

        // §8: the accessible name carries the full story on every update.
        this.accessible_name = model.accessibleName;
    }
});
