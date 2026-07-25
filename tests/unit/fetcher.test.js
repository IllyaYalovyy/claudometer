// Unit tests for src/lib/fetcher.js: the RFC-001 Option C IO layer.
// The file surface (fetchRaw/fetchSnapshot) is exercised against temp
// copies of the real sanitized cache capture; the refresh surface
// (refreshCache) against fake executables in tests/fixtures/bin/ standing
// in for the injectable `claude` argv, emitting real captured envelopes.
// Every failure lands in the RFC-001 taxonomy as a resolved value — a
// rejection escaping into the mainloop fails the test (and run-tests.sh
// additionally fails the file on any unhandled-rejection warning).
import GLib from 'gi://GLib';

import {test, assertEquals, runTests} from '../harness.js';
import {
    NOT_INSTALLED,
    NOT_AUTHENTICATED,
    UNPARSEABLE,
} from '../../src/lib/snapshot.js';
import {
    defaultConfig,
    fetchRaw,
    fetchSnapshot,
    refreshCache,
    REFRESH_FAILED,
    MODEL_INVOKED,
} from '../../src/lib/fetcher.js';

// run-tests.sh runs from the repository root.
const CACHE_FIXTURE = 'tests/fixtures/cached-usage-utilization.json';
const ENVELOPE_FIXTURE = 'tests/fixtures/claude-p-usage-result.json';
const SIGNED_OUT_FIXTURE = 'tests/fixtures/claude-p-usage-signed-out.json';
const EMIT_FILE = 'tests/fixtures/bin/emit-file';
const EMIT_GARBAGE = 'tests/fixtures/bin/emit-garbage';
const EXIT_NONZERO = 'tests/fixtures/bin/exit-nonzero';
const HANG = 'tests/fixtures/bin/hang';

const NOW = 1785000000000;
const FIXTURE_FETCHED_AT = 1784959900803;

const tmpDir = GLib.Dir.make_tmp('claudometer-fetcher-XXXXXX');
const tmpFiles = [];

function readFixture(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return new TextDecoder().decode(bytes);
}

function tmpPath(name) {
    return GLib.build_filenamev([tmpDir, name]);
}

function writeTmp(name, contents) {
    const path = tmpPath(name);
    GLib.file_set_contents(path, contents);
    tmpFiles.push(path);
    return path;
}

// The fetcher reads the whole ~/.claude.json; the capture is only its
// cachedUsageUtilization key, so tests re-wrap it (as snapshot tests do).
function cacheFileText() {
    return JSON.stringify(
        {cachedUsageUtilization: JSON.parse(readFixture(CACHE_FIXTURE))});
}

function mutatedEnvelopePath(name, mutate) {
    const envelope = JSON.parse(readFixture(ENVELOPE_FIXTURE));
    mutate(envelope);
    return writeTmp(name, JSON.stringify(envelope));
}

function assertErrorOnly(snapshot, error, label) {
    assertEquals(snapshot.error, error, `${label}: error`);
    assertEquals(snapshot.fetchedAt, NOW, `${label}: fetchedAt`);
    for (const key of ['session', 'week', 'weekModel'])
        assertEquals(key in snapshot, false, `${label}: no fabricated ${key}`);
}

test('default_config_is_the_rfc_001_source', () => {
    const config = defaultConfig();
    assertEquals(config.filePath,
        GLib.build_filenamev([GLib.get_home_dir(), '.claude.json']));
    assertEquals(JSON.stringify(config.refreshArgv),
        JSON.stringify(['claude', '-p', '/usage', '--output-format', 'json']));
    assertEquals(typeof config.refreshTimeoutMs, 'number');
});

test('fetches_and_parses_the_real_cache_capture_end_to_end', async () => {
    const path = writeTmp('claude.json', cacheFileText());
    const snap = await fetchSnapshot({filePath: path}, NOW);
    assertEquals('error' in snap, false, 'no error on the happy path');
    assertEquals(snap.fetchedAt, FIXTURE_FETCHED_AT,
        'fetchedAt comes from the payload, not from now');
    assertEquals(snap.session.percent, 27);
    assertEquals(snap.week.percent, 34);
    assertEquals(snap.weekModel[0].model, 'Fable');
});

test('missing_cache_file_reads_as_not_installed', async () => {
    const snap = await fetchSnapshot({filePath: tmpPath('absent.json')}, NOW);
    assertErrorOnly(snap, NOT_INSTALLED, 'missing file');
});

test('fetch_raw_rejects_with_a_taxonomy_coded_error', async () => {
    const outcome = await fetchRaw({filePath: tmpPath('absent.json')}).then(
        () => 'resolved', e => e.code);
    assertEquals(outcome, NOT_INSTALLED);
});

test('file_without_the_cache_key_reads_as_not_authenticated', async () => {
    const path = writeTmp('no-cache-key.json', '{"numStartups": 5}');
    const snap = await fetchSnapshot({filePath: path}, NOW);
    assertErrorOnly(snap, NOT_AUTHENTICATED, 'no cache key');
});

test('garbage_cache_file_reads_as_unparseable', async () => {
    const path = writeTmp('garbage.json', 'not-json{{{');
    const snap = await fetchSnapshot({filePath: path}, NOW);
    assertErrorOnly(snap, UNPARSEABLE, 'garbage contents');
});

test('unreadable_cache_path_reads_as_unparseable_not_a_crash', async () => {
    // A directory fails the read with a non-ENOENT IO error: the source
    // exists but cannot be understood — unparseable, cause to the journal.
    const snap = await fetchSnapshot({filePath: tmpDir}, NOW);
    assertErrorOnly(snap, UNPARSEABLE, 'directory path');
});

test('refresh_reports_ok_for_a_healthy_zero_cost_envelope', async () => {
    const result = await refreshCache(
        {refreshArgv: [EMIT_FILE, ENVELOPE_FIXTURE], refreshTimeoutMs: 5000});
    assertEquals(result.ok, true);
    assertEquals('error' in result, false);
});

test('signed_out_refresh_is_healthy_and_the_file_decides_auth', async () => {
    // Probe evidence (fixtures README): a signed-out CLI exits 0 with an
    // all-zero envelope — no distinguishable auth-error output shape — and
    // does not create the cache key. So the refresh is "ok" and
    // NOT_AUTHENTICATED comes from the file surface on the re-read.
    const result = await refreshCache(
        {refreshArgv: [EMIT_FILE, SIGNED_OUT_FIXTURE], refreshTimeoutMs: 5000});
    assertEquals(result.ok, true, 'signed-out envelope is still zero-cost');
    const path = writeTmp('signed-out-claude.json', '{"numStartups": 1}');
    const snap = await fetchSnapshot({filePath: path}, NOW);
    assertEquals(snap.error, NOT_AUTHENTICATED);
});

test('missing_refresh_binary_reads_as_not_installed', async () => {
    const result = await refreshCache({
        refreshArgv: ['/nonexistent/claudometer-no-such-binary'],
        refreshTimeoutMs: 5000,
    });
    assertEquals(result.ok, false);
    assertEquals(result.error, NOT_INSTALLED);
});

test('non_executable_refresh_binary_is_a_refresh_failure', async () => {
    const result = await refreshCache(
        {refreshArgv: [ENVELOPE_FIXTURE], refreshTimeoutMs: 5000});
    assertEquals(result.ok, false);
    assertEquals(result.error, REFRESH_FAILED);
    assertEquals(result.reason, 'spawn-failed');
});

test('nonzero_exit_is_a_refresh_failure', async () => {
    const result = await refreshCache(
        {refreshArgv: [EXIT_NONZERO], refreshTimeoutMs: 5000});
    assertEquals(result.ok, false);
    assertEquals(result.error, REFRESH_FAILED);
    assertEquals(result.reason, 'nonzero-exit');
});

test('garbage_stdout_is_a_refresh_failure_not_a_tripwire_trip', async () => {
    // Non-JSON output is a transient CLI failure (backoff territory), not
    // evidence of a model call — it must not poison the refresh path the
    // way MODEL_INVOKED does.
    const result = await refreshCache(
        {refreshArgv: [EMIT_GARBAGE], refreshTimeoutMs: 5000});
    assertEquals(result.ok, false);
    assertEquals(result.error, REFRESH_FAILED);
    assertEquals(result.reason, 'bad-envelope');
});

test('error_envelope_is_a_refresh_failure', async () => {
    const path = mutatedEnvelopePath('is-error.json', e => {
        e.is_error = true;
    });
    const result = await refreshCache(
        {refreshArgv: [EMIT_FILE, path], refreshTimeoutMs: 5000});
    assertEquals(result.ok, false);
    assertEquals(result.error, REFRESH_FAILED);
    assertEquals(result.reason, 'cli-error');
});

test('any_sign_of_model_involvement_trips_the_g1_tripwire', async () => {
    // RFC-001 drift tripwire 2, fail-closed: a structurally valid envelope
    // on which the zero-cost invariants cannot be asserted — nonzero
    // counters or the counters gone entirely — is MODEL_INVOKED, the
    // signal the scheduler uses to permanently disable the refresh path.
    const cases = [
        ['nonzero cost', e => {
            e.total_cost_usd = 0.42;
        }],
        ['a model turn', e => {
            e.num_turns = 1;
        }],
        ['api duration', e => {
            e.duration_api_ms = 812;
        }],
        ['output tokens', e => {
            e.usage.output_tokens = 7;
        }],
        ['model usage entry', e => {
            e.modelUsage = {'claude-fable-5': {}};
        }],
        ['counters missing', e => {
            delete e.num_turns;
        }],
        ['usage missing', e => {
            delete e.usage;
        }],
    ];
    for (const [label, mutate] of cases) {
        const path = mutatedEnvelopePath(
            `tripwire-${label.replaceAll(' ', '-')}.json`, mutate);
        const result = await refreshCache(
            {refreshArgv: [EMIT_FILE, path], refreshTimeoutMs: 5000});
        assertEquals(result.ok, false, label);
        assertEquals(result.error, MODEL_INVOKED, label);
    }
});

test('hanging_refresh_times_out_and_the_subprocess_is_killed', async () => {
    const pidPath = tmpPath('hang.pid');
    tmpFiles.push(pidPath);
    const result = await refreshCache(
        {refreshArgv: [HANG, pidPath], refreshTimeoutMs: 500});
    assertEquals(result.ok, false);
    assertEquals(result.error, REFRESH_FAILED);
    assertEquals(result.reason, 'timeout');

    const pid = parseInt(readFixture(pidPath).trim(), 10);
    assertEquals(Number.isInteger(pid) && pid > 1, true, 'pidfile written');
    // refreshCache resolves only after communicate() finishes, i.e. after
    // the kill landed and the child was reaped — so by now the PID is gone
    // (or at worst a zombie, which is equally dead).
    let dead = !GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS);
    if (!dead) {
        const stat = readFixture(`/proc/${pid}/stat`);
        dead = stat.slice(stat.lastIndexOf(')')).startsWith(') Z');
    }
    assertEquals(dead, true, 'subprocess no longer runs');
});

runTests();

// Reached only when every test passed (runTests exits non-zero otherwise);
// failures intentionally leave the temp files behind for inspection.
for (const path of tmpFiles)
    GLib.unlink(path);
GLib.rmdir(tmpDir);
