// Pure geometry for the custom gauge icon (designs/UX-DESIGN.md §3.1/§3.3):
// where the clockwise fill arc starts and ends, when a percent change is
// worth a repaint, and where the frame, slash, and `!` overlay sit. All
// values are functions of the surface size, so the same math is crisp at
// 16 px and at 2x scale. Angles use the Cairo convention: 0 = 3 o'clock,
// y-axis pointing down, so increasing angles sweep clockwise on screen.
// No Shell imports; importable under plain `gjs -m` — src/gauge.js only
// applies these numbers to a Cairo context.

// 12 o'clock, where the meter's fill starts (§3.1: fills clockwise).
export const TOP_ANGLE = -Math.PI / 2;

// Non-finite input renders as an empty meter, never as garbage geometry.
export function clampPercent(percent) {
    if (!Number.isFinite(percent))
        return 0;
    return Math.min(100, Math.max(0, percent));
}

// The §3.1 fill wedge: quarter filled at 25%, three-quarters at 75%.
// isEmpty/isFull exist because a zero-length or full-2pi arc is not a
// reliable way to draw "nothing" or "a disc" through Cairo — the painter
// must special-case both ends.
export function fillArc(percent) {
    const p = clampPercent(percent);
    return {
        startAngle: TOP_ANGLE,
        endAngle: TOP_ANGLE + 2 * Math.PI * (p / 100),
        isEmpty: p === 0,
        isFull: p === 100,
    };
}

// Repaint gate: the widget redraws only when this changes. Whole-percent
// buckets match the label's own granularity, so sub-percent jitter between
// polls never churns repaints (issue #8 scope item 4).
export function percentBucket(percent) {
    return Math.round(clampPercent(percent));
}

// Ring outline: centered, stroke never thinner than 1 px, outer stroke
// edge inside the surface. Everything scales linearly with size so a 2x
// surface is exactly the 1x drawing doubled.
export function gaugeFrame(size) {
    const lineWidth = Math.max(1, size / 16);
    const center = size / 2;
    return {center, radius: center - lineWidth, lineWidth};
}

// §3.3 unavailable: the slash across the outline, upper-left to
// lower-right with endpoints on the ring (the action-unavailable idiom).
export function slashLine(size) {
    const {center, radius} = gaugeFrame(size);
    const dx = radius * Math.cos(Math.PI / 4);
    return {
        x1: center - dx, y1: center - dx,
        x2: center + dx, y2: center + dx,
    };
}

// §3.3 warning/critical `!` overlay: a badge in the lower-right corner.
// The painter clears the halo circle before drawing the bar and dot, so
// the glyph stays legible whether it lands on fill, outline, or panel
// background — shape, not color, is what distinguishes the state (§1
// goal 4: state never encoded by color alone).
export function alertOverlay(size) {
    const radius = 0.3 * size;
    const cx = size - radius;
    const cy = size - radius;
    return {
        cx, cy, radius,
        bar: {
            x: cx,
            y1: cy - radius * 0.55,
            y2: cy + radius * 0.1,
            width: radius * 0.35,
        },
        dot: {x: cx, y: cy + radius * 0.55, radius: radius * 0.18},
    };
}
