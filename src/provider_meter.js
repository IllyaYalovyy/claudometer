// RFC-002 compact vertical quota meter. Provider identity uses generic system
// symbolic icons in indicator.js; this file draws only the fixed-size fill.
import Cairo from 'cairo';
import GObject from 'gi://GObject';
import St from 'gi://St';

const METER_WIDTH = 6;
const METER_HEIGHT = 16;

const MeterDrawingArea = GObject.registerClass(
class MeterDrawingArea extends St.DrawingArea {
    _init(params) {
        super._init(params);
        this._styleChangedId = this.connect('style-changed',
            () => this.queue_repaint());
        this.connect('destroy', () => this._onDestroy());
    }

    _onDestroy() {
        this.disconnect(this._styleChangedId);
    }
});

export const VerticalUsageMeter = GObject.registerClass(
class VerticalUsageMeter extends MeterDrawingArea {
    _init() {
        super._init({style_class: 'claudometer-provider-meter'});
        this._percent = null;
        this._state = 'unavailable';
        this._updateSize();
    }

    _updateSize() {
        // Actor dimensions are logical pixels; St scales the Cairo surface.
        // Multiplying this allocation by the monitor scale made the previous
        // marks too wide and vertically clipped on HiDPI panels.
        this.set_size(METER_WIDTH, METER_HEIGHT);
    }

    update(percent, state) {
        const bucket = percent === null
            ? null
            : Math.round(Math.min(100, Math.max(0, percent)));
        if (bucket === this._percent && state === this._state)
            return;
        this._percent = bucket;
        this._state = state;
        this.set_style_class_name('claudometer-provider-meter ' +
            `claudometer-provider-meter-${state}`);
        this.queue_repaint();
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
            const inset = Math.max(1, width * 0.14);
            const x = inset;
            const y = inset;
            const w = width - 2 * inset;
            const h = height - 2 * inset;
            const radius = Math.min(w / 2, inset * 1.35);

            cr.setSourceRGBA(...rgb, alpha * 0.24);
            this._roundRect(cr, x, y, w, h, radius);
            cr.fill();

            if (this._percent !== null && this._percent > 0) {
                const fillHeight = Math.max(w, h * this._percent / 100);
                cr.setSourceRGBA(...rgb, alpha);
                this._roundRect(cr, x, y + h - fillHeight, w, fillHeight,
                    Math.min(radius, fillHeight / 2));
                cr.fill();
            }

            if (this._percent === null) {
                cr.setSourceRGBA(...rgb, alpha);
                cr.setLineWidth(Math.max(1, width * 0.18));
                cr.setLineCap(Cairo.LineCap.ROUND);
                cr.moveTo(x, y + h * 0.72);
                cr.lineTo(x + w, y + h * 0.28);
                cr.stroke();
            }
        } finally {
            cr.$dispose();
        }
    }

    _roundRect(cr, x, y, width, height, radius) {
        cr.newSubPath();
        cr.arc(x + width - radius, y + radius, radius,
            -Math.PI / 2, 0);
        cr.arc(x + width - radius, y + height - radius, radius,
            0, Math.PI / 2);
        cr.arc(x + radius, y + height - radius, radius,
            Math.PI / 2, Math.PI);
        cr.arc(x + radius, y + radius, radius,
            Math.PI, 3 * Math.PI / 2);
        cr.closePath();
    }
});
