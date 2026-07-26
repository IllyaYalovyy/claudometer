// Dropdown menu widget layer (designs/UX-DESIGN.md §4, §5): renders the
// pure descriptors from lib/menu_model.js 1:1 into the indicator's
// PopupMenu. All layout and wording decisions live in the model; this
// file only maps descriptors onto St widgets and wires the two §5/§4.4
// scheduler hooks (menu-open implicit refresh, manual refresh button).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {menuModel} from './lib/menu_model.js';

// §4.2: ~6 px tall bar, logical pixels (scaled for HiDPI by the widget).
const BAR_HEIGHT = 6;
// §4.2: track is the foreground at low opacity; the fill is opaque.
const TRACK_ALPHA = 0.25;
// §5: opening the menu refreshes if the snapshot is older than 15 s.
const OPEN_REFRESH_MAX_AGE_MS = 15000;
// §4.4 freshness wording changes at 30 s / whole-minute boundaries; a 1 s
// tick while the menu is open keeps it live without being busywork.
const TICK_INTERVAL_SEC = 1;

const SPINNER_SIZE = 16;

// §4.2 progress bar: a thin rounded track + fill, drawn like the gauge —
// monochrome in the theme node's foreground color, so the warning/error
// state colors arrive via the claudometer-bar-* stylesheet classes and it
// recolors with the theme.
const UsageBar = GObject.registerClass(
class UsageBar extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'claudometer-bar',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fraction = 0;

        this._styleChangedId = this.connect('style-changed',
            () => this.queue_repaint());
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._scaleChangedId = this._themeContext.connect(
            'notify::scale-factor', () => this._updateSize());
        this.connect('destroy', () => this._onDestroy());
        this._updateSize();
    }

    _onDestroy() {
        this.disconnect(this._styleChangedId);
        this._themeContext.disconnect(this._scaleChangedId);
        this._themeContext = null;
    }

    _updateSize() {
        this.set_height(BAR_HEIGHT * this._themeContext.scale_factor);
    }

    // Apply a section descriptor's bar fields. The state class changes
    // the theme node's color; that emits style-changed, which repaints.
    update(percent, barState) {
        this.set_style_class_name(
            `claudometer-bar claudometer-bar-${barState}`);
        const fraction = Math.min(100, Math.max(0, percent)) / 100;
        if (fraction !== this._fraction) {
            this._fraction = fraction;
            this.queue_repaint();
        }
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            if (width <= 0 || height <= 0)
                return;
            const color = this.get_theme_node().get_foreground_color();
            const rgb = [color.red / 255, color.green / 255, color.blue / 255];
            const alpha = color.alpha / 255;

            cr.setSourceRGBA(...rgb, alpha * TRACK_ALPHA);
            this._pill(cr, width, height);
            cr.fill();

            if (this._fraction > 0) {
                // A fill narrower than the pill's own end caps would
                // degenerate; the smallest visible fill is a dot.
                const fillWidth = Math.max(height, width * this._fraction);
                cr.setSourceRGBA(...rgb, alpha);
                this._pill(cr, fillWidth, height);
                cr.fill();
            }
        } finally {
            cr.$dispose();
        }
    }

    _pill(cr, width, height) {
        const r = height / 2;
        cr.arc(width - r, r, r, -Math.PI / 2, Math.PI / 2);
        cr.arc(r, r, r, Math.PI / 2, 3 * Math.PI / 2);
        cr.closePath();
    }
});

// §4.4 footer row: activatable so PopupMenu keyboard navigation (which
// only reaches menu items, never widgets inside them) can trigger the
// refresh with Enter/Space. activate() is overridden instead of handled
// as a signal because the menu closes itself AFTER any 'activate'
// emission — and a refresh must update the menu in place, not dismiss it.
const RefreshFooterItem = GObject.registerClass(
class RefreshFooterItem extends PopupMenu.PopupBaseMenuItem {
    activate(_event) {
        this.onRefresh?.();
    }
});

function label(text, styleClass = null) {
    return new St.Label({
        text,
        style_class: styleClass,
        y_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

// §4.5 notice lines are sentences, not data rows: wrap them instead of
// letting a long explainer dictate the menu width (cap in stylesheet.css).
function noticeLabel(styleClass) {
    const noticeText = label('', styleClass);
    noticeText.clutter_text.line_wrap = true;
    return noticeText;
}

// Renders menu_model descriptors into `menu` (the indicator's PopupMenu)
// and drives the scheduler: §5 menu-open implicit refresh, §4.4 manual
// refresh with an in-button spinner. The caller feeds every scheduler
// snapshot through update(); a completed fetch — success or failure —
// lands as an update, which also answers any in-flight manual refresh
// (§4.4: the footer updates in place, no toasts).
export class ClaudometerMenu {
    constructor(menu, scheduler) {
        this._menu = menu;
        this._scheduler = scheduler;
        this._snapshot = null;
        this._opts = {};
        this._structureKey = null;
        this._rows = [];
        this._promotedLabel = null;
        this._noticeHeadline = null;
        this._noticeDetail = null;
        this._refreshing = false;
        this._tickId = 0;

        this._openStateId = menu.connect('open-state-changed',
            (_menu, open) => {
                if (open) {
                    this._scheduler.maybeRefresh(OPEN_REFRESH_MAX_AGE_MS);
                    this._startTick();
                } else {
                    this._stopTick();
                }
            });

        this._render(menuModel(null, Date.now(), this._opts));
    }

    destroy() {
        this._stopTick();
        if (this._openStateId !== 0) {
            this._menu.disconnect(this._openStateId);
            this._openStateId = 0;
        }
        this._menu.removeAll();
        this._menu = null;
        this._scheduler = null;
        this._rows = [];
        this._promotedLabel = null;
        this._noticeHeadline = null;
        this._noticeDetail = null;
        this._freshnessLabel = null;
        this._refreshButton = null;
        this._refreshIcon = null;
        this._refreshSpinner = null;
    }

    // Apply a fresh snapshot. `opts` is the menu_model options bag
    // (clock24, thresholds, staleAfterMs) — preferences arrive as args,
    // per the pure-model contract.
    update(snapshot, now, opts = {}) {
        this._snapshot = snapshot;
        this._opts = opts;
        this._setRefreshing(false);
        this._render(menuModel(snapshot, now, opts));
    }

    _render(model) {
        // Rebuild only when the structure changes; text-only changes
        // (countdowns, freshness, notice wording) update labels in place
        // so an open menu keeps its keyboard focus.
        const key = (model.promoted === null ? '' : 'promoted|') +
            (model.notice === null ? '' : 'notice|') +
            model.sections
                .map(s => `${s.kind}:${s.resetText === null ? 0 : 1}`)
                .join('|');
        if (key !== this._structureKey) {
            this._structureKey = key;
            this._rebuild(model);
        }
        if (this._promotedLabel !== null)
            this._promotedLabel.text = model.promoted;
        if (this._noticeHeadline !== null) {
            this._noticeHeadline.text = model.notice.headline;
            this._noticeDetail.text = model.notice.detail;
        }
        model.sections.forEach((section, i) => {
            const row = this._rows[i];
            row.titleLabel.text = section.title;
            row.bar.update(section.percent, section.barState);
            row.percentLabel.text = section.percentText;
            if (row.resetLabel !== null)
                row.resetLabel.text = section.resetText;
        });
        this._updateFooter(model.footer);
    }

    _rebuild(model) {
        this._menu.removeAll();
        this._promotedLabel = null;
        this._noticeHeadline = null;
        this._noticeDetail = null;
        // §4.5 limit-hit promotion: the first line of the menu.
        if (model.promoted !== null) {
            this._promotedLabel = label('', 'claudometer-limit-promoted');
            this._addTextItem(this._promotedLabel);
            this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }
        // §4.5 unavailable notice: sentence, then action; the footer with
        // its refresh button stays — the user's "I fixed it, check again".
        if (model.notice !== null) {
            this._noticeHeadline = noticeLabel('claudometer-notice');
            this._addTextItem(this._noticeHeadline);
            this._noticeDetail = noticeLabel('claudometer-notice');
            this._addTextItem(this._noticeDetail);
            this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }
        this._rows = model.sections.map(section => this._addSection(section));
        this._addFooter();
    }

    // §4.1 section: title row, bar row with the percent datum, reset row
    // (only when the model produced one), then a separator.
    _addSection(section) {
        const titleLabel = label(section.title);
        this._addTextItem(titleLabel);

        const barItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        const bar = new UsageBar();
        const percentLabel = label(section.percentText);
        barItem.add_child(bar);
        barItem.add_child(percentLabel);
        this._menu.addMenuItem(barItem);

        let resetLabel = null;
        if (section.resetText !== null) {
            resetLabel = label(section.resetText);
            this._addTextItem(resetLabel);
        }
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        return {titleLabel, bar, percentLabel, resetLabel};
    }

    _addTextItem(child) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
        item.add_child(child);
        this._menu.addMenuItem(item);
    }

    // §4.4 footer: freshness left, refresh button right. The row is the
    // keyboard path to refresh (see RefreshFooterItem); the button is the
    // §4.4 pointer affordance, whose click is swallowed before the row
    // sees it.
    _addFooter() {
        const item = new RefreshFooterItem();
        item.onRefresh = () => this._onRefreshClicked();
        this._freshnessLabel = label('', 'claudometer-freshness');
        this._freshnessLabel.x_expand = true;
        item.add_child(this._freshnessLabel);

        this._refreshIcon = new St.Icon({
            icon_name: 'view-refresh-symbolic',
            style_class: 'popup-menu-icon',
        });
        this._refreshSpinner = new Spinner(SPINNER_SIZE, {hideOnStop: true});
        const stack = new St.Widget({layout_manager: new Clutter.BinLayout()});
        stack.add_child(this._refreshIcon);
        stack.add_child(this._refreshSpinner);

        this._refreshButton = new St.Button({
            style_class: 'icon-button claudometer-refresh-button',
            can_focus: true,
            child: stack,
            accessible_name: 'Refresh usage data',
        });
        this._refreshButton.connect('clicked', () => this._onRefreshClicked());
        item.add_child(this._refreshButton);
        this._menu.addMenuItem(item);
        this._setRefreshing(this._refreshing);
    }

    _updateFooter(footer) {
        this._freshnessLabel.visible = footer.freshnessText !== null;
        this._freshnessLabel.text = footer.freshnessText ?? '';
        // §4.4: in the stale state the freshness line carries the warning
        // color and explains the dimmed icon.
        if (footer.stale)
            this._freshnessLabel.add_style_class_name('claudometer-footer-stale');
        else
            this._freshnessLabel.remove_style_class_name('claudometer-footer-stale');
    }

    _onRefreshClicked() {
        if (this._refreshing)
            return;
        this._setRefreshing(true);
        this._scheduler.refreshNow();
    }

    _setRefreshing(refreshing) {
        this._refreshing = refreshing;
        if (this._refreshIcon === null)
            return;
        this._refreshIcon.visible = !refreshing;
        if (refreshing)
            this._refreshSpinner.play();
        else
            this._refreshSpinner.stop();
    }

    // §4.4: the freshness line live-updates while the menu is open. Only
    // the footer ticks — §4.3 pairs relative with absolute times exactly
    // so reset rows can tolerate going stale until the next snapshot.
    _startTick() {
        if (this._tickId !== 0)
            return;
        this._tickId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, TICK_INTERVAL_SEC, () => {
                this._updateFooter(
                    menuModel(this._snapshot, Date.now(), this._opts).footer);
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopTick() {
        if (this._tickId !== 0) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }
}
