// Panel indicator widget (designs/UX-DESIGN.md §3): a PanelMenu.Button
// that applies the pure render model from lib/indicator_model.js. All
// display decisions live in the model; this class only maps the model onto
// St properties, so it stays too thin to need widget-level tests.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {GaugeIcon} from './gauge.js';
import {indicatorModel} from './lib/indicator_model.js';
import {ProviderSymbol, VerticalUsageMeter} from './provider_meter.js';

export const ClaudometerIndicator = GObject.registerClass(
class ClaudometerIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Claudometer', false);
        this._stateClass = null;

        const box = new St.BoxLayout({
            style_class: 'panel-status-indicators-box',
        });
        this._box = box;
        this._providerBox = new St.BoxLayout({
            style_class: 'claudometer-provider-list',
            visible: false,
        });
        this._providerItems = new Map();
        box.add_child(this._providerBox);

        this._legacyBox = new St.BoxLayout({
            style_class: 'panel-status-indicators-box',
        });
        this._icon = new GaugeIcon();
        this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._legacyBox.add_child(this._icon);
        this._legacyBox.add_child(this._label);
        box.add_child(this._legacyBox);
        this.add_child(box);
    }

    // Apply a fresh render model. `opts` is the indicator_model options
    // bag (displayMode, thresholds, clock24, staleAfterMs) — preferences
    // arrive as args, per the design's pure-model contract.
    update(snapshot, now, opts = {}) {
        const model = indicatorModel(snapshot, now, opts);

        if (model.items !== undefined) {
            this._legacyBox.visible = false;
            this._providerBox.visible = true;
            this._updateProviderItems(model.items);
            this.opacity = 255;
            this.accessible_name = model.accessibleName;
            return;
        }

        this._providerBox.visible = false;
        this._legacyBox.visible = true;

        this._icon.visible = model.iconVariant !== null;
        if (model.iconVariant !== null)
            this._icon.update(model.iconVariant, model.iconPercent);

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

    _updateProviderItems(models) {
        for (const model of models) {
            let item = this._providerItems.get(model.id);
            if (item === undefined) {
                const actor = new St.BoxLayout({
                    style_class: 'claudometer-provider-item',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                const symbol = new ProviderSymbol(model.symbol);
                const meter = new VerticalUsageMeter();
                actor.add_child(symbol);
                actor.add_child(meter);
                this._providerBox.add_child(actor);
                item = {actor, meter};
                this._providerItems.set(model.id, item);
            }
            item.meter.update(model.percent, model.meterState);
            item.actor.opacity = Math.round(model.opacity * 255);
            item.actor.accessible_name = model.accessibleName;
        }
    }
});
