// Unit tests for src/lib/format.js: the display strings of
// designs/UX-DESIGN.md §3.3 (percent label), §4.3 (countdowns, reset
// rows), §4.4 (freshness footer). Local-time expectations are built with
// the local Date constructor, so they hold in any timezone.
import {test, assertEquals, runTests} from '../harness.js';
import {
    formatPercent,
    formatCountdown,
    formatResetRow,
    formatFreshness,
    formatLastTried,
} from '../../src/lib/format.js';

const MIN = 60000;
const HOUR = 3600000;

test('percent_renders_as_a_rounded_integer_with_a_percent_sign', () => {
    const cases = [
        [0, '0%'], [67, '67%'], [100, '100%'],
        [67.4, '67%'], [27.5, '28%'],
    ];
    for (const [percent, expected] of cases)
        assertEquals(formatPercent(percent), expected, `percent ${percent}`);
});

test('countdown_covers_the_minute_and_hour_edges', () => {
    const cases = [
        [0, '<1 min'],
        [59000, '<1 min'],
        [60000, '1 m'],
        [59 * MIN + 59000, '59 m'],
        [HOUR, '1 h'],
        [HOUR + 12 * MIN, '1 h 12 m'],
        [2 * HOUR + 15 * MIN, '2 h 15 m'],
        [2 * HOUR + 15 * MIN + 59000, '2 h 15 m'],
        [24 * HOUR, '24 h'],
    ];
    for (const [ms, expected] of cases)
        assertEquals(formatCountdown(ms), expected, `${ms} ms`);
});

test('reset_row_within_24h_shows_countdown_and_absolute_time', () => {
    const resetsAt = new Date(2026, 6, 24, 17, 0).getTime();
    const now = resetsAt - (2 * HOUR + 15 * MIN);
    assertEquals(formatResetRow(resetsAt, now, {clock24: true}),
        'Resets in 2 h 15 m (17:00)');
});

test('reset_row_under_a_minute_keeps_the_absolute_time', () => {
    const resetsAt = new Date(2026, 6, 24, 17, 0).getTime();
    assertEquals(formatResetRow(resetsAt, resetsAt - 30000, {clock24: true}),
        'Resets in <1 min (17:00)');
});

test('reset_row_honors_the_12_hour_clock_including_noon_and_midnight', () => {
    const cases = [
        [new Date(2026, 6, 24, 17, 0), '5:00 PM'],
        [new Date(2026, 6, 24, 9, 5), '9:05 AM'],
        [new Date(2026, 6, 24, 12, 0), '12:00 PM'],
        [new Date(2026, 6, 24, 0, 4), '12:04 AM'],
    ];
    for (const [reset, clock] of cases) {
        const resetsAt = reset.getTime();
        assertEquals(formatResetRow(resetsAt, resetsAt - HOUR, {clock24: false}),
            `Resets in 1 h (${clock})`, clock);
    }
});

test('reset_row_pads_24_hour_times_to_two_digits', () => {
    const resetsAt = new Date(2026, 6, 24, 0, 4).getTime();
    assertEquals(formatResetRow(resetsAt, resetsAt - HOUR, {clock24: true}),
        'Resets in 1 h (00:04)');
});

test('reset_row_beyond_24h_drops_the_countdown_for_the_date', () => {
    // §4.3: exactly 24 h away is still a countdown; a minute past that is
    // date-only. 2026-07-28 is a Tuesday.
    const resetsAt = new Date(2026, 6, 28, 17, 0).getTime();
    assertEquals(
        formatResetRow(resetsAt, resetsAt - 24 * HOUR, {clock24: true}),
        'Resets in 24 h (17:00)', 'exactly 24 h stays relative');
    assertEquals(
        formatResetRow(resetsAt, resetsAt - 24 * HOUR - MIN, {clock24: true}),
        'Resets Tue, Jul 28', 'beyond 24 h is date-only');
});

test('freshness_is_just_now_under_30_seconds', () => {
    const now = 1785000000000;
    assertEquals(formatFreshness(now, now), 'Updated just now');
    assertEquals(formatFreshness(now - 29999, now), 'Updated just now');
});

test('freshness_reports_whole_minutes_from_30_seconds_up', () => {
    const now = 1785000000000;
    const cases = [
        [30000, 'Updated 1 min ago'],
        [2 * MIN, 'Updated 2 min ago'],
        [2 * MIN + 29000, 'Updated 2 min ago'],
    ];
    for (const [age, expected] of cases)
        assertEquals(formatFreshness(now - age, now), expected, `${age} ms`);
});

test('freshness_past_the_stale_limit_states_age_without_blaming', () => {
    // §4.4/#16: the stale footer explains the dimmed icon with the honest
    // age alone — a healthy CLI throttles cache rewrites, so old data is
    // not evidence of a failed refresh. Same strict "older than" boundary
    // as derive.js's STALE.
    const now = 1785000000000;
    const opts = {staleAfterMs: 180000};
    assertEquals(formatFreshness(now - 25 * MIN, now, opts),
        'Data is 25 min old');
    assertEquals(formatFreshness(now - (HOUR + 5 * MIN), now, opts),
        'Data is 1 h 5 min old');
    assertEquals(formatFreshness(now - 180000, now, opts),
        'Updated 3 min ago', 'exactly at the limit is not stale');
});

test('freshness_claims_failure_only_when_the_last_refresh_failed', () => {
    // §4.4/#16: the "— last refresh failed" clause tracks the recorded
    // spawn outcome, never the age alone.
    const now = 1785000000000;
    const failed = {staleAfterMs: 180000, lastRefreshFailed: true};
    assertEquals(formatFreshness(now - 25 * MIN, now, failed),
        'Data is 25 min old — last refresh failed');
    assertEquals(formatFreshness(now - 25 * MIN, now,
        {staleAfterMs: 180000, lastRefreshFailed: false}),
        'Data is 25 min old');
    assertEquals(formatFreshness(now - 2 * MIN, now, failed),
        'Updated 2 min ago',
        'a past failure adds nothing while the data is fresh');
});

test('last_tried_mirrors_the_freshness_cadence_without_claiming_data', () => {
    // §4.5 degraded footer: the fetch was attempted, nothing usable came
    // back — "tried", never "updated". Same 30 s / whole-minute wording
    // rhythm as formatFreshness so the footer reads consistently.
    const now = 1785000000000;
    assertEquals(formatLastTried(now - 10000, now), 'Last tried just now');
    assertEquals(formatLastTried(now - 29999, now), 'Last tried just now');
    assertEquals(formatLastTried(now - MIN, now), 'Last tried 1 min ago');
    assertEquals(formatLastTried(now - 25 * MIN, now),
        'Last tried 25 min ago');
});

runTests();
