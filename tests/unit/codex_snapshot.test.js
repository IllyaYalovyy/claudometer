import GLib from 'gi://GLib';

import {test, assertEquals, runTests} from '../harness.js';
import {parseCodexRateLimits} from '../../src/lib/codex_snapshot.js';
import {NOT_AUTHENTICATED, UNPARSEABLE} from '../../src/lib/snapshot.js';

const FIXTURE = 'tests/fixtures/codex-rate-limits-result.json';
const NOW = 1786327200000;

function fixture() {
    const [, bytes] = GLib.file_get_contents(FIXTURE);
    return JSON.parse(new TextDecoder().decode(bytes));
}

test('multi_bucket_view_parses_every_window_without_duplicating_fallback', () => {
    const snap = parseCodexRateLimits(fixture(), NOW);
    assertEquals('error' in snap, false);
    assertEquals(snap.fetchedAt, NOW);
    assertEquals(snap.windows.length, 2,
        'one Codex plus one Spark window, not fallback duplicates');
    assertEquals(snap.windows[0].limitId, 'codex');
    assertEquals('limitName' in snap.windows[0], false);
    assertEquals(snap.windows[0].slot, 'primary');
    assertEquals(snap.windows[0].percent, 0);
    assertEquals(snap.windows[0].durationMins, 10080);
    assertEquals(snap.windows[0].resetsAt, 1786930515000);
    assertEquals(snap.windows[1].limitName, 'GPT-5.3-Codex-Spark');
});

test('single_bucket_fallback_is_supported', () => {
    const data = fixture();
    delete data.rateLimitsByLimitId;
    const snap = parseCodexRateLimits(data, NOW);
    assertEquals(snap.windows.length, 1);
    assertEquals(snap.windows[0].slot, 'primary');
});

test('map_key_is_a_compatible_limit_id_fallback', () => {
    const data = fixture();
    delete data.rateLimitsByLimitId.codex_bengalfox.limitId;
    const snap = parseCodexRateLimits(data, NOW);
    assertEquals(snap.windows[1].limitId, 'codex_bengalfox');
});

test('percent_is_clamped_but_never_coerced', () => {
    const data = fixture();
    data.rateLimitsByLimitId.codex.primary.usedPercent = 112.5;
    assertEquals(parseCodexRateLimits(data, NOW).windows[0].percent, 100);
    data.rateLimitsByLimitId.codex.primary.usedPercent = '25';
    assertEquals(parseCodexRateLimits(data, NOW).error, UNPARSEABLE);
});

test('wrong_typed_consumed_fields_reject_the_whole_snapshot', () => {
    for (const mutate of [
        d => d.rateLimitsByLimitId.codex.primary.windowDurationMins = 0,
        d => d.rateLimitsByLimitId.codex.primary.resetsAt = null,
        d => d.rateLimitsByLimitId.codex.limitName = 42,
        d => d.rateLimitsByLimitId.codex.primary = [],
    ]) {
        const data = fixture();
        mutate(data);
        assertEquals(parseCodexRateLimits(data, NOW).error, UNPARSEABLE);
    }
});

test('wrong_typed_optional_multi_bucket_view_never_silently_falls_back', () => {
    const data = fixture();
    data.rateLimitsByLimitId = 'drifted';
    assertEquals(parseCodexRateLimits(data, NOW).error, UNPARSEABLE);
});

test('missing_or_empty_limits_are_not_authenticated_not_zero_usage', () => {
    for (const result of [{}, {rateLimits: null}, {
        rateLimitsByLimitId: {codex: {
            limitId: 'codex', primary: null, secondary: null,
        }},
    }]) {
        const snap = parseCodexRateLimits(result, NOW);
        assertEquals(snap.error, NOT_AUTHENTICATED);
        assertEquals('windows' in snap, false);
    }
});

runTests();
