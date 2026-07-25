// Minimal unit-test harness for headless `gjs -m` runs (no running Shell).
// A test file imports {test, assertEquals, assertThrows, runTests},
// registers tests, then calls runTests(), which prints a summary and exits
// non-zero if anything failed. See docs/TESTING.md.
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
    let failed = 0;
    for (const {name, fn} of tests) {
        try {
            fn();
            print(`  ok    ${name}`);
        } catch (e) {
            failed += 1;
            print(`  FAIL  ${name}`);
            print(`        ${e.message}`);
        }
    }
    print(`${tests.length - failed}/${tests.length} tests passed`);
    if (failed > 0)
        system.exit(1);
}
