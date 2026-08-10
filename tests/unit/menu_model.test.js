// Unit tests for src/lib/menu_model.js: the dropdown's render model —
// designs/UX-DESIGN.md §4.1 section layout and ordering, §4.2 per-bar
// color independence, §4.3 reset rows, §4.4 footer freshness. Local-time
// expectations are built with the local Date constructor, so they hold in
// any timezone.
import {test, assertEquals, runTests} from '../harness.js';
import {menuModel} from '../../src/lib/menu_model.js';
import {
    NOT_INSTALLED,
    NOT_AUTHENTICATED,
    UNPARSEABLE,
} from '../../src/lib/snapshot.js';

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
        // #16: stale age alone never claims a failure…
        [NOW - 25 * MIN, {}, 'Data is 25 min old', true],
        // …the clause needs the recorded spawn failure.
        [NOW - 25 * MIN, {lastRefreshFailed: true},
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
    // §4.1: no empty placeholder sections. Unavailable snapshots (§4.5)
    // date-stamp the attempt — "Last tried", never "Updated": nothing
    // usable was obtained, so claiming an update would be dishonest.
    for (const [label, snapshot] of [
        ['windowless', {fetchedAt: NOW - 2 * MIN}],
        ['error', {fetchedAt: NOW - 2 * MIN, error: UNPARSEABLE}],
    ]) {
        const m = model(snapshot);
        assertEquals(m.sections.length, 0, `${label}: sections`);
        assertEquals(m.footer.freshnessText, 'Last tried 2 min ago',
            `${label}: freshnessText`);
        assertEquals(m.footer.stale, false, `${label}: stale`);
    }
});

test('null_snapshot_yields_no_sections_and_no_freshness_claim', () => {
    // Before any fetch there is nothing honest to date-stamp (§1).
    const m = model(null);
    assertEquals(m.sections.length, 0);
    assertEquals(m.footer.freshnessText, null);
    assertEquals(m.footer.stale, false);
});

// ------------------------------------------------ §4.5 degraded states

test('healthy_snapshot_carries_no_notice_and_no_promotion', () => {
    const m = model(fullSnapshot());
    assertEquals(m.notice, null);
    assertEquals(m.promoted, null);
});

test('not_installed_renders_the_4_5_not_found_notice', () => {
    const m = model({fetchedAt: NOW - MIN, error: NOT_INSTALLED});
    assertEquals(m.notice.headline,
        'Claude Code was not found on this system.');
    assertEquals(m.notice.detail,
        'Claudometer reads usage from a local Claude Code installation.');
    assertEquals(m.sections.length, 0);
    assertEquals(m.promoted, null);
    // The §4.5 not-found menu carries no "last tried" line: there is no
    // installation to retry against, so the line would imply otherwise.
    assertEquals(m.footer.freshnessText, null);
    assertEquals(m.footer.stale, false);
});

test('unreadable_or_signed_out_renders_cant_read_with_last_tried', () => {
    // §4.5 groups the two: same plain-language sentence, same action.
    for (const error of [NOT_AUTHENTICATED, UNPARSEABLE]) {
        const m = model({fetchedAt: NOW - MIN, error});
        assertEquals(m.notice.headline, "Can't read usage data.", error);
        assertEquals(m.notice.detail,
            'Open Claude Code and sign in, then refresh.', error);
        assertEquals(m.footer.freshnessText, 'Last tried 1 min ago', error);
        assertEquals(m.footer.stale, false, error);
        assertEquals(m.promoted, null, error);
    }
});

test('null_and_windowless_snapshots_render_the_generic_notice', () => {
    // §1: missing data is an explicit unavailable state — the menu must
    // never render blank, even pre-fetch or for an API-key-only cache.
    for (const [label, snapshot] of [
        ['null', null],
        ['windowless', {fetchedAt: NOW}],
    ]) {
        const m = model(snapshot);
        assertEquals(m.notice.headline, "Can't read usage data.", label);
        assertEquals(m.notice.detail,
            'Open Claude Code and sign in, then refresh.', label);
    }
});

test('raw_error_strings_never_surface_in_the_menu_model', () => {
    // §4.5: never a raw error string or exit code in the menu — those go
    // to the journal. An unknown error value gets the generic notice and
    // no fragment of it may appear anywhere in the model output.
    const raw = 'Gio.IOErrorEnum: /home/user/.claude.json: Permission denied';
    const m = model({fetchedAt: NOW - MIN, error: raw});
    const rendered = JSON.stringify(m);
    assertEquals(rendered.includes('Gio.IOErrorEnum'), false, 'error type');
    assertEquals(rendered.includes('/home/user'), false, 'path');
    assertEquals(rendered.includes('Permission denied'), false, 'message');
    assertEquals(m.notice.headline, "Can't read usage data.");
    assertEquals(m.footer.freshnessText, 'Last tried 1 min ago');
});

// --------------------------------------------- §4.5 limit-hit promotion

test('limit_hit_promotes_the_constraint_reset_row_above_the_sections', () => {
    // §4.5: sections render as usual; the constraint's reset row is
    // promoted to the top as the first line.
    const now = RESET - 72 * MIN;
    const m = menuModel({
        fetchedAt: now - MIN,
        session: {percent: 100, resetsAt: RESET},
        week: {percent: 42, resetsAt: FAR_RESET},
    }, now);
    assertEquals(m.promoted, 'Session limit reached — resets in 1 h 12 m (17:00)');
    assertEquals(m.notice, null);
    assertEquals(m.sections.length, 2, 'sections still render');
    assertEquals(m.sections[0].percentText, '100%');
    assertEquals(m.sections[0].barState, 'critical', 'full bar at error color');
});

test('promotion_names_the_constraint_window', () => {
    const cases = [
        [{week: {percent: 100, resetsAt: FAR_RESET}},
            'Weekly limit reached — resets Tue, Jul 28'],
        [{weekModel: [{model: 'Opus', percent: 100, resetsAt: FAR_RESET}]},
            'Weekly Opus limit reached — resets Tue, Jul 28'],
    ];
    for (const [windows, expected] of cases) {
        const m = model({
            fetchedAt: NOW - MIN,
            session: {percent: 50, resetsAt: RESET},
            ...windows,
        });
        assertEquals(m.promoted, expected);
    }
});

test('limit_hit_without_reset_time_promotes_no_fabricated_countdown', () => {
    // §1: a missing resetsAt renders nothing, never an invented countdown.
    const m = model({fetchedAt: NOW - MIN, session: {percent: 100}});
    assertEquals(m.promoted, 'Session limit reached');
});

test('stale_limit_hit_is_not_promoted', () => {
    // derive.js precedence: stale beats limit-hit — a stale reset promise
    // may already have passed, so the promotion is dropped with it.
    const m = model({
        fetchedAt: NOW - 25 * MIN,
        session: {percent: 100, resetsAt: RESET},
    });
    assertEquals(m.promoted, null);
    assertEquals(m.footer.stale, true);
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

test('multi_provider_menu_lists_claude_and_every_codex_bucket_window', () => {
    const m = model({providers: {
        claude: {
            fetchedAt: NOW,
            session: {percent: 67, resetsAt: RESET},
            week: {percent: 42, resetsAt: FAR_RESET},
        },
        codex: {fetchedAt: NOW, windows: [{
            limitId: 'codex', slot: 'primary', percent: 25,
            durationMins: 300, resetsAt: RESET,
        }, {
            limitId: 'codex_spark', limitName: 'GPT-5.3-Codex-Spark',
            slot: 'primary', percent: 18, durationMins: 10080,
            resetsAt: FAR_RESET,
        }]},
    }});
    assertEquals(m.groups.length, 2);
    assertEquals(m.groups[0].title, 'Claude');
    assertEquals(m.groups[0].iconName, 'user-available-symbolic');
    assertEquals(m.groups[0].sections.length, 2);
    assertEquals(m.groups[1].title, 'Codex');
    assertEquals(m.groups[1].iconName, 'utilities-terminal-symbolic');
    assertEquals(m.groups[1].sections.length, 2);
    assertEquals(m.sections.length, 4);
    assertEquals(m.sections[0].providerName, 'Claude');
    assertEquals(m.sections[2].providerName, 'Codex');
    assertEquals(m.sections[0].title, 'Session · 5 hours');
    assertEquals(m.sections[1].title, 'All models · 7 days');
    assertEquals(m.sections[2].title, 'General · 5 hours');
    assertEquals(m.sections[3].title,
        'GPT-5.3-Codex-Spark · 7 days');
    assertEquals(m.notice, null);
    assertEquals(m.footer.freshnessText, 'Claude now · Codex now');
});

test('provider_names_are_grouped_once_and_dynamic_titles_are_bounded', () => {
    const longName = 'A-very-long-model-name-that-must-not-resize-the-popup';
    const m = model({providers: {
        claude: {fetchedAt: NOW, weekModel: [{
            model: longName, percent: 12, resetsAt: FAR_RESET,
        }]},
        codex: {fetchedAt: NOW, windows: [{
            limitId: 'long', limitName: longName, slot: 'primary', percent: 9,
            durationMins: 10080, resetsAt: FAR_RESET,
        }]},
    }});
    assertEquals(m.sections.every(section =>
        !section.title.startsWith('Claude') &&
        !section.title.startsWith('Codex')), true);
    assertEquals(m.sections.every(section => section.title.length <= 34), true);
    assertEquals(m.sections[0].title.includes('…'), true);
    assertEquals(m.sections[1].title.includes('…'), true);
});

test('one_unavailable_provider_keeps_the_other_rows_and_gets_its_own_notice', () => {
    const m = model({providers: {
        claude: {fetchedAt: NOW, session: {percent: 40}},
        codex: {fetchedAt: NOW, error: NOT_INSTALLED},
    }});
    assertEquals(m.sections.length, 1);
    assertEquals(m.groups.length, 1);
    assertEquals(m.groups[0].title, 'Claude');
    assertEquals(m.sections[0].title, 'Session · 5 hours');
    assertEquals(m.notice.headline, 'Codex was not found on this system.');
    assertEquals(m.footer.freshnessText, 'Claude now · Codex unavailable');
});

runTests();
