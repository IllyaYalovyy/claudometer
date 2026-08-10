import {test, assertEquals, runTests} from '../harness.js';
import {MultiUsageSource} from '../../src/lib/multi_source.js';
import {NOT_INSTALLED} from '../../src/lib/snapshot.js';

const NOW = 1786327200000;

function provider(snapshot, failed = false) {
    return {
        lastRefreshFailed: failed,
        fetch: (_now, opts) => Promise.resolve({...snapshot, manual: opts.manual}),
    };
}

test('provider_results_remain_independent_and_manual_reaches_both', async () => {
    const source = new MultiUsageSource({
        claude: provider({fetchedAt: NOW, session: {percent: 67}}),
        codex: provider({fetchedAt: NOW, error: NOT_INSTALLED}, true),
    });
    const snapshot = await source.fetch(NOW, {manual: true});
    assertEquals(snapshot.providers.claude.session.percent, 67);
    assertEquals(snapshot.providers.codex.error, NOT_INSTALLED);
    assertEquals(snapshot.providers.claude.manual, true);
    assertEquals(snapshot.providers.codex.manual, true);
    assertEquals(source.lastRefreshFailed, true);
    assertEquals(source.lastRefreshFailedByProvider.claude, false);
    assertEquals(source.lastRefreshFailedByProvider.codex, true);
});

runTests();
