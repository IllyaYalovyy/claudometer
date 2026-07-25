// Minimal unit-test harness for headless `gjs -m` runs (no running Shell).
// A test file imports {test, assertEquals, assertThrows, runTests},
// registers tests, then calls runTests(), which prints a summary and exits
// non-zero if anything failed. Test functions may be async: each one is
// awaited in registration order while a GLib main loop runs, so
// promise-based code under test has a live main context to complete on.
// See docs/TESTING.md.
import GLib from 'gi://GLib';
import system from 'system';

const tests = [];

export function test(name, fn) {
    tests.push({name, fn});
}

export function assertEquals(actual, expected, message = '') {
    if (!Object.is(actual, expected)) {
        const detail = message ? ` (${message})` : '';
        throw new Error(`assertEquals failed${detail}: ` +
            `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

export function assertThrows(fn, message = '') {
    try {
        fn();
    } catch (e) {
        return e;
    }
    const detail = message ? ` (${message})` : '';
    throw new Error(`assertThrows failed${detail}: function did not throw`);
}

export function runTests() {
    const loop = new GLib.MainLoop(null, false);
    let settled = false;
    let failed = 0;
    (async () => {
        for (const {name, fn} of tests) {
            try {
                await fn();
                print(`  ok    ${name}`);
            } catch (e) {
                failed += 1;
                print(`  FAIL  ${name}`);
                print(`        ${e.message}`);
            }
        }
    })().finally(() => {
        settled = true;
        loop.quit();
    });
    // The runner promise may settle before run() if every test is
    // synchronous (microtasks drain between statements in gjs); quitting a
    // loop that never ran would then hang it forever.
    if (!settled)
        loop.run();
    print(`${tests.length - failed}/${tests.length} tests passed`);
    if (failed > 0)
        system.exit(1);
}
