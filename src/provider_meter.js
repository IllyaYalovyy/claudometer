// RFC-002 compact provider marks and vertical quota meter. Both marks are
// original geometry rather than copied vendor logos: a warm six-ray bloom for
// Claude and a six-node neural ring for Codex.
import Cairo from 'cairo';
import GObject from 'gi://GObject';
import St from 'gi://St';

const MARK_SIZE = 16;
const METER_WIDTH = 9;
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

export const ProviderMark = GObject.registerClass(
class ProviderMark extends MeterDrawingArea {
    _init(mark) {
        super._init({style_class: 'claudometer-provider-mark ' +
            `claudometer-provider-mark-${mark}`});
        this._mark = mark;
        this.set_size(MARK_SIZE, MARK_SIZE);
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            const size = Math.min(width, height);
            if (size <= 0)
                return;
            cr.translate((width - size) / 2, (height - size) / 2);
            const color = this.get_theme_node().get_foreground_color();
            cr.setSourceRGBA(color.red / 255, color.green / 255,
                color.blue / 255, color.alpha / 255);
            if (this._mark === 'claude')
                this._paintClaude(cr, size);
            else
                this._paintCodex(cr, size);
        } finally {
            cr.$dispose();
        }
    }

    _paintClaude(cr, size) {
        const center = size / 2;
        const inner = size * 0.11;
        const outer = size * 0.39;
        cr.setLineWidth(size * 0.145);
        cr.setLineCap(Cairo.LineCap.ROUND);
        for (let i = 0; i < 6; i++) {
            const angle = i * Math.PI / 3;
            cr.moveTo(center + Math.cos(angle) * inner,
                center + Math.sin(angle) * inner);
            cr.lineTo(center + Math.cos(angle) * outer,
                center + Math.sin(angle) * outer);
        }
        cr.stroke();
        cr.arc(center, center, size * 0.09, 0, 2 * Math.PI);
        cr.fill();
    }

    _paintCodex(cr, size) {
        const center = size / 2;
        const ring = size * 0.29;
        const node = size * 0.072;
        cr.setLineWidth(size * 0.085);
        cr.arc(center, center, ring, 0, 2 * Math.PI);
        cr.stroke();
        for (let i = 0; i < 6; i++) {
            const angle = i * Math.PI / 3 - Math.PI / 2;
            cr.arc(center + Math.cos(angle) * ring,
                center + Math.sin(angle) * ring,
                node, 0, 2 * Math.PI);
            cr.fill();
        }
        cr.arc(center, center, size * 0.075, 0, 2 * Math.PI);
        cr.fill();
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

            cr.setSourceRGBA(...rgb, alpha * 0.40);
            this._roundRect(cr, x, y, w, h, radius);
            cr.fill();

            if (this._percent !== null && this._percent > 0) {
                const fillHeight = Math.max(2, h * this._percent / 100);
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
