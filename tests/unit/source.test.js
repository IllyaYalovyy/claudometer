// Unit tests for src/lib/source.js: the composed RFC-001 Option C data
// source — file read first, CLI refresh spawn only when the cache is
// older than the refresh threshold (or the fetch is manual), re-read
// after every spawn, and the fail-closed G1 tripwire that permanently
// disables the refresh path on MODEL_INVOKED. Spawns are counted through
// the run log the tests/fixtures/bin/record-refresh fake appends to.
import GLib from 'gi://GLib';

import {test, assertEquals, runTests} from '../harness.js';
import {NOT_AUTHENTICATED, NOT_INSTALLED} from '../../src/lib/snapshot.js';
import {UsageSource, DEFAULT_REFRESH_AFTER_MS, MAX_INEFFECTIVE_REFRESHES}
    from '../../src/lib/source.js';

const CACHE_FIXTURE = 'tests/fixtures/cached-usage-utilization.json';
const ENVELOPE_FIXTURE = 'tests/fixtures/claude-p-usage-result.json';
const SIGNED_OUT_FIXTURE = 'tests/fixtures/claude-p-usage-signed-out.json';
const RECORD_REFRESH = 'tests/fixtures/bin/record-refresh';
const EXIT_NONZERO = 'tests/fixtures/bin/exit-nonzero';

// The committed capture's own freshness stamp anchors every clock here.
const FETCHED = 1784959900803;
const FRESH_NOW = FETCHED + 30000;
const STALE_NOW = FETCHED + 10 * 60000;

const tmpDir = GLib.Dir.make_tmp('claudometer-source-XXXXXX');
const tmpFiles = [];

function readText(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return new TextDecoder().decode(bytes);
}

function tmpPath(name) {
    const path = GLib.build_filenamev([tmpDir, name]);
    if (!tmpFiles.includes(path))
        tmpFiles.push(path);
    return path;
}

function writeTmp(name, contents) {
    const path = tmpPath(name);
    GLib.file_set_contents(path, contents);
    return path;
}

// The source reads a whole ~/.claude.json; the capture is only its
// cachedUsageUtilization value, so tests re-wrap it — optionally mutated,
// as the fetcher tests mutate the envelope capture.
function cacheFileText(mutate = null) {
    const cache = JSON.parse(readText(CACHE_FIXTURE));
    mutate?.(cache);
    return JSON.stringify({cachedUsageUtilization: cache});
}

function spawnCount(logPath) {
    if (!GLib.file_test(logPath, GLib.FileTest.EXISTS))
        return 0;
    return readText(logPath).split('\n').filter(l => l === 'run').length;
}

// A source over a temp cache file and the record-refresh fake. `install`
// makes the fake copy that file over the cache path, standing in for the
// real CLI rewriting ~/.claude.json. Extra `sourceOpts` reach the
// UsageSource constructor (the #17 persistence wiring).
function makeSource(name, {cache = null, envelope = ENVELOPE_FIXTURE,
    install = null, argv = null, sourceOpts = {}} = {}) {
    const filePath = tmpPath(`${name}-claude.json`);
    if (cache !== null)
        GLib.file_set_contents(filePath, cache);
    const log = tmpPath(`${name}-runs.log`);
    const refreshArgv = argv ?? [
        RECORD_REFRESH, log, envelope,
        ...install !== null ? [install, filePath] : [],
    ];
    const source = new UsageSource({
        config: {filePath, refreshArgv, refreshTimeoutMs: 5000},
        ...sourceOpts,
    });
    return {source, log, filePath};
}

// An envelope the G1 tripwire must reject: the committed capture with a
// nonzero cost, written once for every persistence test to share.
function trippedEnvelope(name) {
    const envelope = JSON.parse(readText(ENVELOPE_FIXTURE));
    envelope.total_cost_usd = 0.42;
    return writeTmp(`${name}-envelope.json`, JSON.stringify(envelope));
}

test('default_refresh_threshold_is_the_ux_6_poll_interval', () => {
    assertEquals(DEFAULT_REFRESH_AFTER_MS, 60000);
});

test('fresh_cache_is_served_without_spawning_the_cli', async () => {
    const {source, log} = makeSource('fresh', {cache: cacheFileText()});
    const snap = await source.fetch(FRESH_NOW);
    assertEquals(snap.session.percent, 27);
    assertEquals(snap.fetchedAt, FETCHED, 'freshness from the payload');
    assertEquals(spawnCount(log), 0, 'no spawn for a fresh cache');
});

test('stale_cache_spawns_one_refresh_then_rereads_the_file', async () => {
    const rewritten = writeTmp('stale-rewritten.json', cacheFileText(c => {
        c.fetchedAtMs = STALE_NOW - 5000;
        c.utilization.limits[0].percent = 47;
    }));
    const {source, log} = makeSource('stale',
        {cache: cacheFileText(), install: rewritten});
    const snap = await source.fetch(STALE_NOW);
    assertEquals(spawnCount(log), 1, 'exactly one spawn');
    assertEquals(snap.fetchedAt, STALE_NOW - 5000,
        're-read picked up the rewritten cache');
    assertEquals(snap.session.percent, 47);
});

test('manual_fetch_spawns_even_when_the_cache_is_fresh', async () => {
    // RFC-001: manual refresh always spawns — §4.4's "I just ended a big
    // session" escape hatch must not be gated by the freshness threshold.
    const {source, log} = makeSource('manual', {cache: cacheFileText()});
    await source.fetch(FRESH_NOW, {manual: true});
    assertEquals(spawnCount(log), 1);
});

test('refresh_failure_keeps_the_readable_file_data', async () => {
    // A failed spawn degrades to visible staleness later, never to lost
    // data: the file is still the parse surface.
    const {source} = makeSource('spawn-fails',
        {cache: cacheFileText(), argv: [EXIT_NONZERO]});
    const snap = await source.fetch(STALE_NOW);
    assertEquals('error' in snap, false);
    assertEquals(snap.session.percent, 27);
    assertEquals(snap.fetchedAt, FETCHED, 'stamp untouched by the failure');
});

test('refresh_failure_journal_line_names_the_command_tried', async () => {
    // #18: a broken refresh path must be diagnosable from the journal —
    // the warning has to say *which* resolved command failed, not only
    // that something did. (gjs's console.warn is unpatchable, hence the
    // injectable sink.)
    const warnings = [];
    const {source} = makeSource('journal-cmd', {
        cache: cacheFileText(),
        argv: [EXIT_NONZERO],
        sourceOpts: {warn: message => warnings.push(message)},
    });
    const snap = await source.fetch(STALE_NOW);
    assertEquals(snap.session.percent, 27, 'file data still served');
    assertEquals(warnings.length, 1, 'exactly one warning for the failure');
    assertEquals(warnings[0].includes(EXIT_NONZERO), true,
        `journal names the command tried, got: ${warnings[0]}`);
});

test('last_refresh_failed_tracks_the_latest_spawn_outcome', async () => {
    // #16: the §4.4 footer may claim "last refresh failed" only when the
    // last spawn actually failed — old data alone is not evidence (the
    // CLI throttles cache rewrites). The source records the outcome.
    const filePath = writeTmp('outcome-claude.json', cacheFileText());
    const log = tmpPath('outcome-runs.log');
    const config = {filePath, refreshArgv: [EXIT_NONZERO],
        refreshTimeoutMs: 5000};
    const source = new UsageSource({config, warn: () => {}});
    assertEquals(source.lastRefreshFailed, false, 'no spawn yet');

    const fresh = await source.fetch(FRESH_NOW);
    assertEquals('error' in fresh, false, 'precondition: fresh cache');
    assertEquals(source.lastRefreshFailed, false,
        'a fetch without a spawn records nothing');

    await source.fetch(STALE_NOW);
    assertEquals(source.lastRefreshFailed, true, 'failed spawn recorded');

    config.refreshArgv = [RECORD_REFRESH, log, ENVELOPE_FIXTURE];
    await source.fetch(STALE_NOW + 60000);
    assertEquals(source.lastRefreshFailed, false,
        'a healthy spawn clears the failure even if the cache stays old');
});

test('missing_file_and_missing_binary_read_as_not_installed', async () => {
    const {source} = makeSource('nothing',
        {argv: ['/nonexistent/claudometer-no-such-binary']});
    const snap = await source.fetch(FRESH_NOW);
    assertEquals(snap.error, NOT_INSTALLED);
    assertEquals(snap.fetchedAt, FRESH_NOW);
});

test('refresh_creates_the_missing_cache_and_recovers', async () => {
    // UT-003 recovery: no cache file yet, but a healthy CLI writes one on
    // the refresh — the same fetch comes back with real data.
    const installable = writeTmp('recover-cache.json', cacheFileText(c => {
        c.fetchedAtMs = FRESH_NOW - 5000;
    }));
    const {source, log} = makeSource('recover', {install: installable});
    const snap = await source.fetch(FRESH_NOW);
    assertEquals(spawnCount(log), 1, 'missing data always tries a refresh');
    assertEquals('error' in snap, false);
    assertEquals(snap.session.percent, 27);
});

test('signed_out_cache_stays_not_authenticated_after_a_refresh', async () => {
    // Probe evidence: a signed-out CLI exits 0 with a zero-cost envelope
    // and does not create the cache key — the file decides auth.
    const {source, log} = makeSource('signed-out', {
        cache: '{"numStartups": 5}',
        envelope: SIGNED_OUT_FIXTURE,
    });
    const snap = await source.fetch(FRESH_NOW);
    assertEquals(spawnCount(log), 1, 'the refresh was attempted');
    assertEquals(snap.error, NOT_AUTHENTICATED);
});

// A signed-out (or API-key-only) setup: the cache file never gains the
// usage key, so every spawn is ineffective — the file read errors again.
// #19's polite give-up caps those spawns; distinct from the G1 tripwire.
function makeSignedOutSource(name, sourceOpts = {}) {
    return makeSource(name, {
        cache: '{"numStartups": 5}',
        envelope: SIGNED_OUT_FIXTURE,
        sourceOpts,
    });
}

async function pollTimes(source, count, startNow) {
    let snap = null;
    for (let i = 0; i < count; i++)
        snap = await source.fetch(startNow + i * 60000);
    return snap;
}

test('signed_out_polls_stop_spawning_after_max_ineffective_refreshes', async () => {
    // #19: every refresh on a signed-out setup exits 0 without creating
    // the cache key, so the error snapshot recurs forever. The spawn
    // count must plateau instead of tracking the poll count.
    const {source, log} = makeSignedOutSource('give-up');
    const snap = await pollTimes(source, MAX_INEFFECTIVE_REFRESHES + 4,
        FRESH_NOW);
    assertEquals(spawnCount(log), MAX_INEFFECTIVE_REFRESHES,
        'spawns plateau at the give-up threshold');
    assertEquals(snap.error, NOT_AUTHENTICATED,
        'the file-read result is still served after the give-up');
});

test('give_up_is_journaled_once_and_names_the_manual_re_arm', async () => {
    // The signed-out spawns themselves succeed (exit 0, zero-cost
    // envelope), so the only warning across many polls must be the
    // single give-up line — one line per suspension, not per tick.
    const warnings = [];
    const {source} = makeSignedOutSource('give-up-journal',
        {warn: message => warnings.push(message)});
    await pollTimes(source, MAX_INEFFECTIVE_REFRESHES + 4, FRESH_NOW);
    assertEquals(warnings.length, 1,
        `exactly one give-up warning, got: ${JSON.stringify(warnings)}`);
    assertEquals(warnings[0].includes('manual refresh re-arms'), true,
        `journal explains the re-arm, got: ${warnings[0]}`);
});

test('manual_refresh_spawns_while_suspended_and_re_arms_auto_refreshes', async () => {
    // #19 scope 2: a manual refresh always spawns, and it resets the
    // ineffective counter — the auto path gets a fresh allowance of
    // attempts before suspending again.
    const {source, log} = makeSignedOutSource('re-arm');
    await pollTimes(source, MAX_INEFFECTIVE_REFRESHES + 2, FRESH_NOW);
    assertEquals(spawnCount(log), MAX_INEFFECTIVE_REFRESHES,
        'precondition: suspended');

    await source.fetch(STALE_NOW, {manual: true});
    assertEquals(spawnCount(log), MAX_INEFFECTIVE_REFRESHES + 1,
        'manual still spawns while suspended');

    await pollTimes(source, MAX_INEFFECTIVE_REFRESHES + 2, STALE_NOW + 60000);
    assertEquals(spawnCount(log), 2 * MAX_INEFFECTIVE_REFRESHES,
        'auto refreshes resumed after the manual re-arm, then plateaued again');
});

test('sign_in_after_give_up_re_arms_the_stale_refresh_path', async () => {
    // #19 scope 2: the file's content changing (the user signed in; the
    // cache key appeared) lifts the suspension — the next stale cycle
    // spawns normally without any manual action.
    const {source, log, filePath} = makeSignedOutSource('sign-in');
    await pollTimes(source, MAX_INEFFECTIVE_REFRESHES + 1, FRESH_NOW);
    assertEquals(spawnCount(log), MAX_INEFFECTIVE_REFRESHES,
        'precondition: suspended');

    GLib.file_set_contents(filePath, cacheFileText());
    const snap = await source.fetch(STALE_NOW);
    assertEquals(spawnCount(log), MAX_INEFFECTIVE_REFRESHES + 1,
        'a stale-but-valid cache spawns again after sign-in');
    assertEquals(snap.session.percent, 27, 'the signed-in data is served');
});

test('model_invoked_permanently_disables_the_refresh_path', async () => {
    // RFC-001 G1 tripwire, fail-closed: one envelope that cannot prove
    // zero cost and the CLI is never spawned again — degraded freshness
    // is acceptable, spending tokens is not. The file data stays served.
    const {source, log} = makeSource('tripwire',
        {cache: cacheFileText(), envelope: trippedEnvelope('tripwire')});

    assertEquals(source.refreshDisabled, false);
    const first = await source.fetch(STALE_NOW);
    assertEquals(spawnCount(log), 1);
    assertEquals(source.refreshDisabled, true, 'tripwire tripped');
    assertEquals(source.lastRefreshFailed, true,
        'the tripping spawn counts as a failed refresh (#16)');
    assertEquals(first.session.percent, 27, 'file data still served');

    const second = await source.fetch(STALE_NOW + 60000, {manual: true});
    assertEquals(spawnCount(log), 1, 'no further spawns, even manual');
    assertEquals(second.session.percent, 27);
});

test('persisted_disable_holds_from_the_first_fetch', async () => {
    // #17: the tripwire survives sessions — a source constructed over the
    // persisted refresh-path-disabled flag never spawns, not even for a
    // manual refresh, while the cache file stays served read-only.
    const {source, log} = makeSource('persisted', {
        cache: cacheFileText(),
        envelope: trippedEnvelope('persisted'),
        sourceOpts: {refreshDisabled: true},
    });
    assertEquals(source.refreshDisabled, true, 'armed from construction');
    const snap = await source.fetch(STALE_NOW, {manual: true});
    assertEquals(spawnCount(log), 0, 'no spawn under a persisted disable');
    assertEquals(snap.session.percent, 27, 'file data still served');
});

test('tripwire_reports_the_disable_to_the_persistence_hook', async () => {
    // The source is pure (no GSettings import); persistence happens
    // through the injected hook, called exactly once per trip.
    let persisted = 0;
    const {source, log} = makeSource('persist-hook', {
        cache: cacheFileText(),
        envelope: trippedEnvelope('persist-hook'),
        sourceOpts: {onRefreshDisabled: () => persisted++},
    });
    await source.fetch(STALE_NOW);
    assertEquals(source.refreshDisabled, true);
    assertEquals(persisted, 1, 'the disable was handed to the hook');
    await source.fetch(STALE_NOW + 60000, {manual: true});
    assertEquals(spawnCount(log), 1, 'still no further spawns');
    assertEquals(persisted, 1, 'the hook fires once, not per fetch');
});

test('ordinary_refresh_failures_never_reach_the_persistence_hook', async () => {
    // Only a MODEL_INVOKED verdict is the G1 tripwire; a plain broken
    // spawn must not latch the persisted disable.
    let persisted = 0;
    const {source} = makeSource('plain-failure', {
        cache: cacheFileText(),
        argv: [EXIT_NONZERO],
        sourceOpts: {onRefreshDisabled: () => persisted++},
    });
    await source.fetch(STALE_NOW);
    assertEquals(source.refreshDisabled, false);
    assertEquals(persisted, 0);
});

test('explicit_re_enable_re_arms_the_refresh_path_and_the_tripwire', async () => {
    // RFC-001: re-enable only by explicit user action. After
    // setRefreshDisabled(false) the spawn path works again — and trips
    // again on the next bad envelope, re-reporting to the hook.
    let persisted = 0;
    const {source, log} = makeSource('re-enable', {
        cache: cacheFileText(),
        envelope: trippedEnvelope('re-enable'),
        sourceOpts: {onRefreshDisabled: () => persisted++},
    });
    await source.fetch(STALE_NOW);
    assertEquals(source.refreshDisabled, true, 'precondition: tripped');
    assertEquals(spawnCount(log), 1);

    source.setRefreshDisabled(false);
    assertEquals(source.refreshDisabled, false, 're-armed');
    await source.fetch(STALE_NOW + 60000);
    assertEquals(spawnCount(log), 2, 'the refresh path spawns again');
    assertEquals(source.refreshDisabled, true, 'and trips again');
    assertEquals(persisted, 2, 'the re-trip reaches the hook too');
});

runTests();

// Reached only when every test passed; failures leave the temp files
// behind for inspection (same policy as the fetcher tests).
for (const path of tmpFiles)
    GLib.unlink(path);
GLib.rmdir(tmpDir);
