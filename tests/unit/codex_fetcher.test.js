import GLib from 'gi://GLib';

import {test, assertEquals, runTests} from '../harness.js';
import {
    CODEX_READ_FAILED,
    defaultCodexConfig,
    fetchCodexSnapshot,
} from '../../src/lib/codex_fetcher.js';
import {NOT_INSTALLED} from '../../src/lib/snapshot.js';

const RESPONSE = 'tests/fixtures/codex-app-server-response.json';
const EMIT_FILE = 'tests/fixtures/bin/emit-file';
const EMIT_GARBAGE = 'tests/fixtures/bin/emit-garbage';
const EXIT_NONZERO = 'tests/fixtures/bin/exit-nonzero';
const HANG = 'tests/fixtures/bin/hang';
const NOW = 1786327200000;
const tmpDir = GLib.Dir.make_tmp('claudometer-codex-fetcher-XXXXXX');
const tmpFiles = [];

function tmpPath(name) {
    const path = GLib.build_filenamev([tmpDir, name]);
    tmpFiles.push(path);
    return path;
}

test('default_config_uses_the_documented_app_server_command', () => {
    const config = defaultCodexConfig();
    assertEquals(JSON.stringify(config.appServerArgv),
        JSON.stringify(['codex', 'app-server']));
    assertEquals(config.timeoutMs, 15000);
});

test('reads_the_matching_rate_limit_response_and_reaps_the_server', async () => {
    const snap = await fetchCodexSnapshot({
        appServerArgv: [EMIT_FILE, RESPONSE], timeoutMs: 5000,
    }, NOW);
    assertEquals('error' in snap, false);
    assertEquals(snap.windows.length, 2);
    assertEquals(snap.windows[1].limitName, 'GPT-5.3-Codex-Spark');
});

test('missing_codex_is_an_explicit_not_installed_snapshot', async () => {
    const snap = await fetchCodexSnapshot({
        appServerArgv: ['/nonexistent/claudometer-no-codex'], timeoutMs: 5000,
    }, NOW);
    assertEquals(snap.error, NOT_INSTALLED);
    assertEquals(snap.fetchedAt, NOW);
});

test('garbage_and_early_exit_are_resolved_failures', async () => {
    const garbage = await fetchCodexSnapshot({
        appServerArgv: [EMIT_GARBAGE], timeoutMs: 5000,
    }, NOW);
    assertEquals(garbage.error, CODEX_READ_FAILED);
    assertEquals(garbage.reason, 'bad-json');

    const exited = await fetchCodexSnapshot({
        appServerArgv: [EXIT_NONZERO], timeoutMs: 5000,
    }, NOW);
    assertEquals(exited.error, CODEX_READ_FAILED);
    assertEquals(exited.reason, 'early-eof');
});

test('hung_server_is_killed_and_reaped_at_timeout', async () => {
    const pidFile = tmpPath('hung.pid');
    const snap = await fetchCodexSnapshot({
        appServerArgv: [HANG, pidFile], timeoutMs: 25,
    }, NOW);
    assertEquals(snap.error, CODEX_READ_FAILED);
    assertEquals(snap.reason, 'timeout');
    const [, pidBytes] = GLib.file_get_contents(pidFile);
    const pid = Number(new TextDecoder().decode(pidBytes).trim());
    assertEquals(GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS), false,
        'timeout promise resolves only after the child is reaped');
});

runTests();

for (const file of tmpFiles)
    GLib.unlink(file);
GLib.rmdir(tmpDir);
