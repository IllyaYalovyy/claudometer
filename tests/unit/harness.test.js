// Self-test for the unit-test harness: proves the assertions actually
// discriminate, so a later test suite that passes is passing for real.
import {test, assertEquals, assertThrows, runTests} from '../harness.js';

test('assertEquals_accepts_identical_values', () => {
    assertEquals(2 + 2, 4);
    assertEquals('CM', 'CM');
    assertEquals(null, null);
});

test('assertEquals_rejects_differing_values', () => {
    assertThrows(() => assertEquals(1, 2));
    assertThrows(() => assertEquals('a', 'b'));
    // No implicit type coercion: 1 and '1' are different values.
    assertThrows(() => assertEquals(1, '1'));
});

test('assertThrows_rejects_a_function_that_does_not_throw', () => {
    let rejected = false;
    try {
        assertThrows(() => 42);
    } catch {
        rejected = true;
    }
    assertEquals(rejected, true);
});

runTests();
