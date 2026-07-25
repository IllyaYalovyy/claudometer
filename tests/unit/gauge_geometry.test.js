// Unit tests for src/lib/gauge_geometry.js: the pure geometry behind the
// §3.1 gauge icon — clockwise fill arc from 12 o'clock, the repaint
// bucket, frame/slash/overlay placement, and their crisp 2x scaling.
// Angles use the Cairo convention (0 = 3 o'clock, y-axis down, so
// increasing angles sweep clockwise on screen).
import {test, assertEquals, runTests} from '../harness.js';
import {
    TOP_ANGLE,
    alertOverlay,
    clampPercent,
    fillArc,
    gaugeFrame,
    percentBucket,
    slashLine,
} from '../../src/lib/gauge_geometry.js';

const HALF_PI = Math.PI / 2;

// Angle assertions tolerate float rounding from the percent -> radians
// conversion; a real regression is off by whole quadrants, not 1e-12.
function assertNear(actual, expected, message) {
    if (!(Math.abs(actual - expected) < 1e-9)) {
        throw new Error(`assertNear failed (${message}): ` +
            `expected ${expected}, got ${actual}`);
    }
}

test('fill_starts_at_12_oclock', () => {
    assertNear(TOP_ANGLE, -HALF_PI, 'TOP_ANGLE');
    assertNear(fillArc(25).startAngle, -HALF_PI, 'startAngle');
});

test('fill_sweeps_clockwise_to_the_percent_mark', () => {
    // 25% -> 3 o'clock, 50% -> 6 o'clock, 100% -> full circle back to top.
    assertNear(fillArc(25).endAngle, 0, '25% ends at 3 o\'clock');
    assertNear(fillArc(50).endAngle, HALF_PI, '50% ends at 6 o\'clock');
    assertNear(fillArc(100).endAngle, -HALF_PI + 2 * Math.PI, '100% full');
});

test('empty_and_full_meters_are_flagged_for_the_painter', () => {
    // 0% must draw no wedge at all and 100% a full disc — a zero-length
    // or 2pi arc through cairo is not reliably either.
    assertEquals(fillArc(0).isEmpty, true, '0% empty');
    assertEquals(fillArc(0).isFull, false, '0% not full');
    assertEquals(fillArc(100).isFull, true, '100% full');
    assertEquals(fillArc(100).isEmpty, false, '100% not empty');
    assertEquals(fillArc(50).isEmpty, false, '50% not empty');
    assertEquals(fillArc(50).isFull, false, '50% not full');
});

test('out_of_range_percent_clamps_instead_of_overdrawing', () => {
    assertEquals(clampPercent(-10), 0, 'negative clamps to 0');
    assertEquals(clampPercent(250), 100, 'over 100 clamps to 100');
    assertEquals(clampPercent(NaN), 0, 'NaN renders as empty, not garbage');
    assertNear(fillArc(250).endAngle, fillArc(100).endAngle, 'arc clamps');
    assertEquals(fillArc(-10).isEmpty, true, 'negative arc is empty');
});

test('repaint_bucket_is_whole_percent_and_clamped', () => {
    // The widget repaints only when this bucket changes; sub-percent
    // jitter inside one bucket must not churn repaints.
    assertEquals(percentBucket(67.4), 67);
    assertEquals(percentBucket(67.6), 68);
    assertEquals(percentBucket(-3), 0);
    assertEquals(percentBucket(150), 100);
    assertEquals(percentBucket(NaN), 0);
});

test('frame_fits_the_stroke_inside_the_icon_at_16px', () => {
    const {center, radius, lineWidth} = gaugeFrame(16);
    assertEquals(center, 8, 'centered');
    assertEquals(lineWidth >= 1, true, 'stroke never thinner than 1px');
    assertEquals(center + radius + lineWidth / 2 <= 16, true,
        'outline stays inside the surface');
    assertEquals(radius > 16 / 4, true, 'ring is not vestigially small');
});

test('frame_scales_linearly_for_crisp_2x_rendering', () => {
    const one = gaugeFrame(16);
    const two = gaugeFrame(32);
    assertEquals(two.center, one.center * 2, 'center');
    assertEquals(two.radius, one.radius * 2, 'radius');
    assertEquals(two.lineWidth, one.lineWidth * 2, 'lineWidth');
});

test('slash_crosses_the_ring_corner_to_corner', () => {
    // §3.3 unavailable: outline + slash. Endpoints sit on the ring,
    // upper-left to lower-right, symmetric about the center.
    const size = 16;
    const {center, radius} = gaugeFrame(size);
    const {x1, y1, x2, y2} = slashLine(size);
    assertEquals(x1 < x2 && y1 < y2, true, 'runs upper-left to lower-right');
    assertNear(x1 + x2, 2 * center, 'x-symmetric about center');
    assertNear(y1 + y2, 2 * center, 'y-symmetric about center');
    const onRing = Math.hypot(x1 - center, y1 - center);
    assertNear(onRing, radius, 'endpoint lies on the ring');
});

test('alert_overlay_sits_in_the_lower_right_inside_the_icon', () => {
    const size = 16;
    const o = alertOverlay(size);
    assertEquals(o.cx > size / 2 && o.cy > size / 2, true,
        'lower-right quadrant');
    assertEquals(o.cx + o.radius <= size && o.cy + o.radius <= size, true,
        'halo stays inside the surface');
    assertEquals(o.cx - o.radius >= 0 && o.cy - o.radius >= 0, true,
        'halo does not spill out the top-left');
});

test('alert_overlay_reads_as_an_exclamation_mark', () => {
    // Bar above dot, visibly separated, both inside the cleared halo —
    // otherwise the glyph collapses into a blob at 16px.
    const o = alertOverlay(16);
    assertEquals(o.bar.y1 < o.bar.y2, true, 'bar top above bar bottom');
    assertEquals(o.dot.y - o.dot.radius > o.bar.y2, true,
        'dot separated below the bar');
    assertEquals(o.bar.y1 >= o.cy - o.radius, true, 'bar inside halo');
    assertEquals(o.dot.y + o.dot.radius <= o.cy + o.radius, true,
        'dot inside halo');
    assertEquals(o.bar.width > 0 && o.dot.radius > 0, true,
        'strokes have real thickness');
});

test('alert_overlay_scales_linearly_for_crisp_2x_rendering', () => {
    const one = alertOverlay(16);
    const two = alertOverlay(32);
    assertEquals(two.cx, one.cx * 2, 'cx');
    assertEquals(two.cy, one.cy * 2, 'cy');
    assertEquals(two.radius, one.radius * 2, 'radius');
    assertEquals(two.bar.y1, one.bar.y1 * 2, 'bar.y1');
    assertEquals(two.dot.radius, one.dot.radius * 2, 'dot.radius');
});

runTests();
