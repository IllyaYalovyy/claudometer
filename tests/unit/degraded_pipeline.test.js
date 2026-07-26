// End-to-end degraded-state wiring (UT-003): the real pipeline — fetcher
// taxonomy → UsageSource → Scheduler → indicator/menu render models —
// driven headlessly over a temp cache file and the tests/fixtures/bin/
// fakes standing in for the `claude` CLI. Walks the UT-003 story: nothing
// installed → unavailable menu; install + refresh → recovery; limit hit →
// promotion; refresh breaks → honest staleness. Only the St layer (which
// applies these models 1:1) is outside this test; that is the manual
// nested-Shell walkthrough.
import GLib from 'gi://GLib';

import {test, assertEquals, runTests} from '../harness.js';
import {NOT_INSTALLED} from '../../src/lib/snapshot.js';
import {UsageSource} from '../../src/lib/source.js';
import {Scheduler} from '../../src/lib/scheduler.js';
import {indicatorModel} from '../../src/lib/indicator_model.js';
import {menuModel} from '../../src/lib/menu_model.js';

const CACHE_FIXTURE = 'tests/fixtures/cached-usage-utilization.json';
const ENVELOPE_FIXTURE = 'tests/fixtures/claude-p-usage-result.json';
const RECORD_REFRESH = 'tests/fixtures/bin/record-refresh';
const EXIT_NONZERO = 'tests/fixtures/bin/exit-nonzero';

const MIN = 60000;
// Local-time anchor (same technique as the menu model tests): a 17:00
// reset keeps every countdown/clock expectation timezone-independent.
const RESET = new Date(2026, 6, 24, 17, 0).getTime();
const T0 = RESET - 135 * MIN;
const T1 = RESET - 72 * MIN;

const tmpDir = GLib.Dir.make_tmp('claudometer-pipeline-XXXXXX');
const tmpFiles = [];

function tmpPath(name) {
    const path = GLib.build_filenamev([tmpDir, name]);
    if (!tmpFiles.includes(path))
        tmpFiles.push(path);
    return path;
}

function readText(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return new TextDecoder().decode(bytes);
}

// Rewraps the committed capture as a full cache file, with the session
// window's percent/reset/freshness pinned to the scenario's clock.
function cacheText({percent, fetchedAtMs}) {
    const cache = JSON.parse(readText(CACHE_FIXTURE));
    cache.fetchedAtMs = fetchedAtMs;
    cache.utilization.limits[0].percent = percent;
    cache.utilization.limits[0].resets_at = new Date(RESET).toISOString();
    return JSON.stringify({cachedUsageUtilization: cache});
}

// Deterministic timer surface (same shape as the scheduler tests').
class FakeTimers {
    constructor() {
        this.pending = new Map();
        this._nextId = 1;
    }

    addSeconds(sec, cb) {
        const id = this._nextId++;
        this.pending.set(id, {sec, cb});
        return id;
    }

    remove(id) {
        this.pending.delete(id);
    }

    fireNext() {
        const [id, timer] = this.pending.entries().next().value;
        this.pending.delete(id);
        timer.cb();
    }
}

test('ut_003_walkthrough_not_installed_recover_limit_hit_go_stale', async () => {
    const filePath = tmpPath('claude.json');
    const log = tmpPath('runs.log');
    const installable = tmpPath('cli-written-cache.json');
    // Starts with neither a cache file nor a `claude` binary.
    const config = {
        filePath,
        refreshArgv: ['/nonexistent/claudometer-no-such-binary'],
        refreshTimeoutMs: 5000,
    };
    const source = new UsageSource({config});
    const clock = {value: T0};
    const timers = new FakeTimers();
    let waiters = [];
    const scheduler = new Scheduler({
        fetch: (now, opts) => source.fetch(now, opts),
        onSnapshot: s => waiters.splice(0).forEach(resolve => resolve(s)),
        now: () => clock.value,
        timers,
    });
    const nextSnapshot = () => new Promise(resolve => waiters.push(resolve));

    // 1. Nothing installed: the whole pipeline lands on the §3.3/§4.5
    // unavailable state — no number anywhere, the not-found notice.
    let delivered = nextSnapshot();
    scheduler.start();
    let snapshot = await delivered;
    assertEquals(snapshot.error, NOT_INSTALLED);
    let indicator = indicatorModel(snapshot, clock.value);
    assertEquals(indicator.iconVariant, 'meter-unavailable');
    assertEquals(indicator.labelText, null, 'no fabricated number');
    assertEquals(indicator.accessibleName, 'Claude usage data unavailable');
    let menu = menuModel(snapshot, clock.value);
    assertEquals(menu.notice.headline,
        'Claude Code was not found on this system.');
    assertEquals(menu.sections.length, 0);

    // 2. The user installs Claude Code and hits refresh (UT-003
    // recovery): the CLI fake writes the cache; the same manual fetch
    // comes back with real data.
    GLib.file_set_contents(installable,
        cacheText({percent: 27, fetchedAtMs: T0 - 5000}));
    config.refreshArgv =
        [RECORD_REFRESH, log, ENVELOPE_FIXTURE, installable, filePath];
    delivered = nextSnapshot();
    scheduler.refreshNow();
    snapshot = await delivered;
    assertEquals('error' in snapshot, false, 'refresh recovered');
    indicator = indicatorModel(snapshot, clock.value);
    // The fixture's weekly window (34%) outranks the session (27%): the
    // §2 constraint is the highest-percent window.
    assertEquals(indicator.labelText, '34%');
    assertEquals(indicator.styleClass, 'claudometer-normal');
    menu = menuModel(snapshot, clock.value);
    assertEquals(menu.notice, null);
    assertEquals(menu.sections.length, 3, 'all fixture windows render');
    assertEquals(menu.sections[0].resetText, 'Resets in 2 h 15 m (17:00)');
    assertEquals(menu.footer.freshnessText, 'Updated just now');

    // 3. The session window hits 100%: hourglass + countdown in the
    // panel, the promoted reset line first in the menu (§4.5).
    clock.value = T1;
    GLib.file_set_contents(installable,
        cacheText({percent: 100, fetchedAtMs: T1 - 5000}));
    delivered = nextSnapshot();
    scheduler.refreshNow();
    snapshot = await delivered;
    indicator = indicatorModel(snapshot, clock.value);
    assertEquals(indicator.iconVariant, 'hourglass');
    assertEquals(indicator.labelText, '1 h 12 m');
    assertEquals(indicator.styleClass, 'claudometer-limit-hit');
    menu = menuModel(snapshot, clock.value);
    assertEquals(menu.promoted,
        'Session limit reached — resets in 1 h 12 m (17:00)');
    assertEquals(menu.sections[0].barState, 'critical');

    // 4. The refresh path breaks and the data ages out: the pipeline
    // degrades to the honest stale state, never to a silent wrong number.
    config.refreshArgv = [EXIT_NONZERO];
    clock.value = T1 + 11 * MIN;
    delivered = nextSnapshot();
    timers.fireNext();
    snapshot = await delivered;
    indicator = indicatorModel(snapshot, clock.value);
    assertEquals(indicator.styleClass, 'claudometer-stale');
    assertEquals(indicator.opacity, 0.55);
    assertEquals(indicator.labelText, '100%', 'last value, dimmed');
    menu = menuModel(snapshot, clock.value);
    assertEquals(menu.footer.freshnessText,
        'Data is 11 min old — last refresh failed');
    assertEquals(menu.footer.stale, true);
    assertEquals(menu.promoted, null, 'stale drops the promotion');

    scheduler.stop();
});

runTests();

// Reached only when every test passed; failures leave the temp files
// behind for inspection (same policy as the fetcher tests).
for (const path of tmpFiles)
    GLib.unlink(path);
GLib.rmdir(tmpDir);
