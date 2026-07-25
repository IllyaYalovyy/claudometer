// Unit tests for src/lib/menu_model.js: the dropdown's render model —
// designs/UX-DESIGN.md §4.1 section layout and ordering, §4.2 per-bar
// color independence, §4.3 reset rows, §4.4 footer freshness. Local-time
// expectations are built with the local Date constructor, so they hold in
// any timezone.
import {test, assertEquals, runTests} from '../harness.js';
import {menuModel} from '../../src/lib/menu_model.js';

const MIN = 60000;

// 2 h 15 m before a 17:00 reset — the §4.1 mockup's session reset row.
const RESET = new Date(2026, 6, 24, 17, 0).getTime();
const NOW = RESET - 135 * MIN;
// Beyond 24 h, so weekly reset rows read as a date. 2026-07-28 is a
// Tuesday.
const FAR_RESET = new Date(2026, 6, 28, 17, 0).getTime();

// The §4.1 mockup snapshot: every window present, fetched 2 min ago.
function fullSnapshot() {
    return {
        fetchedAt: NOW - 2 * MIN,
        session: {percent: 67, resetsAt: RESET},
        week: {percent: 42, resetsAt: FAR_RESET},
        weekModel: [{model: 'Opus', percent: 18, resetsAt: FAR_RESET}],
    };
}

function model(snapshot, opts = {}) {
    return menuModel(snapshot, NOW, opts);
}

test('all_windows_present_renders_the_4_1_mockup_in_order', () => {
    const {sections, footer} = model(fullSnapshot());
    // Column order: kind, title, percent, percentText, barState, resetText
    // — one row per §4.1 mockup section, top to bottom.
    const expected = [
        ['session', 'Session (5-hour window)', 67, '67%', 'normal',
            'Resets in 2 h 15 m (17:00)'],
        ['week', 'Week — all models', 42, '42%', 'normal',
            'Resets Tue, Jul 28'],
        ['weekModel', 'Week — Opus', 18, '18%', 'normal',
            'Resets Tue, Jul 28'],
    ];
    assertEquals(sections.length, expected.length, 'section count');
    expected.forEach(([kind, title, percent, percentText, barState,
        resetText], i) => {
        assertEquals(sections[i].kind, kind, `[${i}].kind`);
        assertEquals(sections[i].title, title, `[${i}].title`);
        assertEquals(sections[i].percent, percent, `[${i}].percent`);
        assertEquals(sections[i].percentText, percentText,
            `[${i}].percentText`);
        assertEquals(sections[i].barState, barState, `[${i}].barState`);
        assertEquals(sections[i].resetText, resetText, `[${i}].resetText`);
    });
    assertEquals(footer.freshnessText, 'Updated 2 min ago');
    assertEquals(footer.stale, false);
});

test('single_window_snapshot_renders_exactly_one_section', () => {
    // §4.1: sections appear only if their data exists — no empty
    // placeholders for windows the plan doesn't have.
    const {sections} = model(
        {fetchedAt: NOW, week: {percent: 42, resetsAt: FAR_RESET}});
    assertEquals(sections.length, 1);
    assertEquals(sections[0].kind, 'week');
    assertEquals(sections[0].title, 'Week — all models');
});

test('multiple_per_model_windows_keep_snapshot_order', () => {
    const {sections} = model({
        fetchedAt: NOW,
        weekModel: [
            {model: 'Opus', percent: 18, resetsAt: FAR_RESET},
            {model: 'Sonnet', percent: 7, resetsAt: FAR_RESET},
        ],
    });
    assertEquals(sections.length, 2);
    assertEquals(sections[0].title, 'Week — Opus');
    assertEquals(sections[1].title, 'Week — Sonnet');
});

test('each_bar_colors_by_its_own_windows_thresholds', () => {
    // §4.2: the weekly bar isn't painted red because the session bar is.
    const {sections} = model({
        fetchedAt: NOW,
        session: {percent: 97, resetsAt: RESET},
        week: {percent: 42, resetsAt: FAR_RESET},
        weekModel: [{model: 'Opus', percent: 84, resetsAt: FAR_RESET}],
    });
    assertEquals(sections[0].barState, 'critical');
    assertEquals(sections[1].barState, 'normal');
    assertEquals(sections[2].barState, 'warning');
});

test('bar_state_honors_configured_thresholds', () => {
    const at60 = {fetchedAt: NOW, session: {percent: 60, resetsAt: RESET}};
    assertEquals(model(at60).sections[0].barState, 'normal');
    assertEquals(model(at60, {warningAt: 50}).sections[0].barState,
        'warning');
    assertEquals(model(at60, {warningAt: 30, criticalAt: 55})
        .sections[0].barState, 'critical');
});

test('limit_hit_window_renders_a_full_bar_at_critical', () => {
    // §4.5 limit hit: the bar full, at error color.
    const {sections} = model(
        {fetchedAt: NOW, session: {percent: 100, resetsAt: RESET}});
    assertEquals(sections[0].percent, 100);
    assertEquals(sections[0].percentText, '100%');
    assertEquals(sections[0].barState, 'critical');
});

test('footer_freshness_covers_just_now_minutes_and_stale', () => {
    const session = {percent: 67, resetsAt: RESET};
    const cases = [
        // [fetchedAt, opts, freshnessText, stale] — §4.4 wording.
        [NOW - 10000, {}, 'Updated just now', false],
        [NOW - 2 * MIN, {}, 'Updated 2 min ago', false],
        [NOW - 25 * MIN, {},
            'Data is 25 min old — last refresh failed', true],
        // Configured staleAfterMs moves the boundary with it.
        [NOW - 25 * MIN, {staleAfterMs: 30 * MIN},
            'Updated 25 min ago', false],
    ];
    for (const [fetchedAt, opts, text, stale] of cases) {
        const {footer} = model({fetchedAt, session}, opts);
        assertEquals(footer.freshnessText, text, `${text}: freshnessText`);
        assertEquals(footer.stale, stale, `${text}: stale`);
    }
});

test('absent_windows_yield_no_sections_but_keep_the_footer', () => {
    // §4.1: no empty placeholder sections; the footer (freshness +
    // refresh escape hatch) still renders for windowless snapshots.
    for (const [label, snapshot] of [
        ['windowless', {fetchedAt: NOW - 2 * MIN}],
        ['error', {fetchedAt: NOW - 2 * MIN, error: 'unparseable'}],
    ]) {
        const m = model(snapshot);
        assertEquals(m.sections.length, 0, `${label}: sections`);
        assertEquals(m.footer.freshnessText, 'Updated 2 min ago',
            `${label}: freshnessText`);
    }
});

test('null_snapshot_yields_no_sections_and_no_freshness_claim', () => {
    // Before any fetch there is nothing honest to date-stamp (§1).
    const m = model(null);
    assertEquals(m.sections.length, 0);
    assertEquals(m.footer.freshnessText, null);
    assertEquals(m.footer.stale, false);
});

test('window_without_reset_time_drops_the_reset_row', () => {
    // §2 marks resetsAt optional; a missing instant renders nothing
    // rather than a fabricated countdown (§1).
    const {sections} = model({fetchedAt: NOW, session: {percent: 67}});
    assertEquals(sections.length, 1);
    assertEquals(sections[0].resetText, null);
});

test('reset_rows_honor_the_12_hour_clock_option', () => {
    const {sections} = model(fullSnapshot(), {clock24: false});
    assertEquals(sections[0].resetText, 'Resets in 2 h 15 m (5:00 PM)');
});

runTests();
