// The custom gauge icon (designs/UX-DESIGN.md §3.1/§3.3): an
// St.DrawingArea painting a circular meter that fills clockwise with
// usage, plus the alert (`!` overlay), hourglass, and unavailable
// (outline + slash) variants. All placement math lives in
// lib/gauge_geometry.js; this widget only applies it to a Cairo context.
// Monochrome by construction: every stroke uses the theme node's
// foreground color, so state colors arrive via the indicator's
// stylesheet classes and the icon recolors like any -symbolic icon.

import Cairo from 'cairo';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {
    alertOverlay,
    fillArc,
    gaugeFrame,
    percentBucket,
    slashLine,
} from './lib/gauge_geometry.js';

// §3.1: 16 px symbolic-icon footprint, scaled up on HiDPI.
const ICON_SIZE = 16;

export const GaugeIcon = GObject.registerClass(
class GaugeIcon extends St.DrawingArea {
    _init() {
        super._init({style_class: 'system-status-icon'});
        this._variant = 'meter';
        this._bucket = 0;

        // Redraw when the theme (foreground color) changes; sizing tracks
        // the HiDPI scale factor. The theme context outlives this widget,
        // so its handler must be disconnected on destroy.
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
        const scale = this._themeContext.scale_factor;
        this.set_size(ICON_SIZE * scale, ICON_SIZE * scale);
    }

    // Show `variant` ('meter' | 'meter-alert' | 'hourglass' |
    // 'meter-unavailable'), filled to `percent` for the meter variants.
    // Repaints only when the drawn shape actually changes: per-second
    // model updates with an unchanged whole-percent bucket are free.
    update(variant, percent) {
        const isMeter = variant === 'meter' || variant === 'meter-alert';
        const bucket = isMeter ? percentBucket(percent) : null;
        if (variant === this._variant && bucket === this._bucket)
            return;
        this._variant = variant;
        this._bucket = bucket;
        this.queue_repaint();
    }

    vfunc_repaint() {
        // get_context() hands this JS wrapper a Cairo context per repaint;
        // $dispose() releases it deterministically instead of waiting on
        // the GC (the classic DrawingArea leak).
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            const size = Math.min(width, height);
            if (size <= 0)
                return;
            // Surface pixels, not logical pixels: at 2x scale `size` is
            // 32 and every geometry value doubles, keeping edges crisp.
            cr.translate((width - size) / 2, (height - size) / 2);

            const color = this.get_theme_node().get_foreground_color();
            cr.setSourceRGBA(color.red / 255, color.green / 255,
                color.blue / 255, color.alpha / 255);

            const frame = gaugeFrame(size);
            switch (this._variant) {
            case 'meter':
                this._paintMeter(cr, frame);
                break;
            case 'meter-alert':
                this._paintMeter(cr, frame);
                this._paintAlert(cr, size);
                break;
            case 'hourglass':
                this._paintHourglass(cr, frame);
                break;
            case 'meter-unavailable':
                this._paintUnavailable(cr, frame, size);
                break;
            }
        } finally {
            cr.$dispose();
        }
    }

    // §3.1: circle outline, pie wedge filled clockwise from 12 o'clock.
    _paintMeter(cr, {center, radius, lineWidth}) {
        cr.setLineWidth(lineWidth);
        cr.arc(center, center, radius, 0, 2 * Math.PI);
        cr.stroke();

        const arc = fillArc(this._bucket);
        if (arc.isEmpty)
            return;
        if (arc.isFull) {
            cr.arc(center, center, radius, 0, 2 * Math.PI);
        } else {
            cr.moveTo(center, center);
            cr.arc(center, center, radius, arc.startAngle, arc.endAngle);
            cr.closePath();
        }
        cr.fill();
    }

    // §3.3 warning/critical: `!` badge over a cleared halo, so the glyph
    // reads against fill, outline, or panel background alike.
    _paintAlert(cr, size) {
        const o = alertOverlay(size);
        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.arc(o.cx, o.cy, o.radius, 0, 2 * Math.PI);
        cr.fill();
        cr.restore();

        cr.setLineWidth(o.bar.width);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.moveTo(o.bar.x, o.bar.y1);
        cr.lineTo(o.bar.x, o.bar.y2);
        cr.stroke();
        cr.arc(o.dot.x, o.dot.y, o.dot.radius, 0, 2 * Math.PI);
        cr.fill();
    }

    // §3.3 limit hit: a filled bowtie between top and bottom caps — the
    // self-crossing path fills as the two hourglass bulbs.
    _paintHourglass(cr, {center, radius}) {
        const halfWidth = radius * 0.62;
        const top = center - radius * 0.8;
        const bottom = center + radius * 0.8;
        cr.moveTo(center - halfWidth, top);
        cr.lineTo(center + halfWidth, top);
        cr.lineTo(center - halfWidth, bottom);
        cr.lineTo(center + halfWidth, bottom);
        cr.closePath();
        cr.fill();
    }

    // §3.3 unavailable: empty outline with a corner-to-corner slash.
    _paintUnavailable(cr, {center, radius, lineWidth}, size) {
        cr.setLineWidth(lineWidth);
        cr.arc(center, center, radius, 0, 2 * Math.PI);
        cr.stroke();

        const slash = slashLine(size);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.moveTo(slash.x1, slash.y1);
        cr.lineTo(slash.x2, slash.y2);
        cr.stroke();
    }
});
