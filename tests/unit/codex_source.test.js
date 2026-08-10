import {test, assertEquals, runTests} from '../harness.js';
import {
    CodexUsageSource,
    MAX_CODEX_INEFFECTIVE_REFRESHES,
} from '../../src/lib/codex_source.js';
import {CODEX_READ_FAILED} from '../../src/lib/codex_fetcher.js';

const NOW = 1786327200000;

function good(now = NOW, percent = 25) {
    return {fetchedAt: now, windows: [{
        limitId: 'codex', slot: 'primary', percent,
        durationMins: 300, resetsAt: now + 3600000,
    }]};
}

function bad(now) {
    return {fetchedAt: now, error: CODEX_READ_FAILED, reason: 'offline'};
}

test('successful_snapshot_is_cached_until_the_refresh_threshold', async () => {
    let calls = 0;
    const source = new CodexUsageSource({fetcher: (_config, now) => {
        calls++;
        return Promise.resolve(good(now));
    }});
    await source.fetch(NOW);
    const cached = await source.fetch(NOW + 30000);
    assertEquals(calls, 1);
    assertEquals(cached.fetchedAt, NOW);
    await source.fetch(NOW + 60000);
    assertEquals(calls, 2);
});

test('transient_failure_keeps_last_good_data_with_its_old_timestamp', async () => {
    let calls = 0;
    const source = new CodexUsageSource({warn: () => {},
        fetcher: (_config, now) => Promise.resolve(
            calls++ === 0 ? good(now, 42) : bad(now)),
    });
    await source.fetch(NOW);
    const staleCandidate = await source.fetch(NOW + 60000);
    assertEquals(staleCandidate.windows[0].percent, 42);
    assertEquals(staleCandidate.fetchedAt, NOW,
        'failure never restamps cached usage as fresh');
    assertEquals(source.lastRefreshFailed, true);
});

test('initial_failures_plateau_until_manual_refresh_rearms', async () => {
    let calls = 0;
    const warnings = [];
    const source = new CodexUsageSource({
        warn: message => warnings.push(message),
        fetcher: (_config, now) => {
            calls++;
            return Promise.resolve(bad(now));
        },
    });
    for (let i = 0; i < MAX_CODEX_INEFFECTIVE_REFRESHES + 3; i++)
        await source.fetch(NOW + i * 60000);
    assertEquals(calls, MAX_CODEX_INEFFECTIVE_REFRESHES);
    assertEquals(warnings.at(-1).includes('manual refresh re-arms'), true);
    await source.fetch(NOW + 10 * 60000, {manual: true});
    assertEquals(calls, MAX_CODEX_INEFFECTIVE_REFRESHES + 1);
});

runTests();
