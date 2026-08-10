// RFC-002 compact provider marks and vertical quota meters. Both marks are
// original Cairo geometry: an eight-ray spark for Claude and generic source
// code brackets for Codex. No vendor logos or external artwork are used.
import Cairo from 'cairo';
import GObject from 'gi://GObject';
import St from 'gi://St';

const SYMBOL_SIZE = 18;
const METER_WIDTH = 6;
const METER_HEIGHT = 18;

const ScaledDrawingArea = GObject.registerClass(
class ScaledDrawingArea extends St.DrawingArea {
    _init(params) {
        super._init(params);
        this._styleChangedId = this.connect('style-changed',
            () => this.queue_repaint());
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._scaleChangedId = this._themeContext.connect(
            'notify::scale-factor', () => this._updateSize());
        this.connect('destroy', () => this._onDestroy());
    }

    _onDestroy() {
        this.disconnect(this._styleChangedId);
        this._themeContext.disconnect(this._scaleChangedId);
        this._themeContext = null;
    }
});

export const ProviderSymbol = GObject.registerClass(
class ProviderSymbol extends ScaledDrawingArea {
    _init(symbol) {
        super._init({style_class: 'system-status-icon'});
        this._symbol = symbol;
        this._updateSize();
    }

    _updateSize() {
        const scale = this._themeContext.scale_factor;
        this.set_size(SYMBOL_SIZE * scale, SYMBOL_SIZE * scale);
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
            cr.setLineWidth(size * 0.115);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            if (this._symbol === 'spark')
                this._paintSpark(cr, size);
            else
                this._paintCode(cr, size);
        } finally {
            cr.$dispose();
        }
    }

    _paintSpark(cr, size) {
        const c = size / 2;
        const inner = size * 0.16;
        const outer = size * 0.42;
        for (let i = 0; i < 8; i++) {
            const angle = i * Math.PI / 4;
            const length = i % 2 === 0 ? outer : outer * 0.72;
            cr.moveTo(c + Math.cos(angle) * inner,
                c + Math.sin(angle) * inner);
            cr.lineTo(c + Math.cos(angle) * length,
                c + Math.sin(angle) * length);
        }
        cr.stroke();
        cr.arc(c, c, size * 0.075, 0, 2 * Math.PI);
        cr.fill();
    }

    _paintCode(cr, size) {
        const left = size * 0.18;
        const right = size * 0.82;
        const mid = size * 0.5;
        const top = size * 0.25;
        const bottom = size * 0.75;
        cr.moveTo(mid - size * 0.08, top);
        cr.lineTo(left, mid);
        cr.lineTo(mid - size * 0.08, bottom);
        cr.moveTo(mid + size * 0.08, top);
        cr.lineTo(right, mid);
        cr.lineTo(mid + size * 0.08, bottom);
        // A center slash keeps the tiny mark legible as generic source code
        // (`</>`) rather than as a diamond/eye at panel scale.
        cr.moveTo(mid + size * 0.08, size * 0.2);
        cr.lineTo(mid - size * 0.08, size * 0.8);
        cr.stroke();
    }
});

export const VerticalUsageMeter = GObject.registerClass(
class VerticalUsageMeter extends ScaledDrawingArea {
    _init() {
        super._init({style_class: 'claudometer-provider-meter'});
        this._percent = null;
        this._state = 'unavailable';
        this._updateSize();
    }

    _updateSize() {
        const scale = this._themeContext.scale_factor;
        this.set_size(METER_WIDTH * scale, METER_HEIGHT * scale);
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
