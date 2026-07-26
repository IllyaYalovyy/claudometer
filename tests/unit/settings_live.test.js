// Integration-style coverage for the live settings wiring (issue #12):
// extension.js answers every GSettings changed:: signal by rebuilding
// displayOptions() from the normalized preferences and re-feeding the
// *current* snapshot through the pure render models (plus rebasing the
// scheduler's cadence). These tests drive exactly that composition
// headlessly: same snapshot, changed preference, flipped outputs — no
// disable/enable in between. The Shell-coupled signal plumbing itself is
// verified manually (task report).
import {test, assertEquals, runTests} from '../harness.js';
import {DEFAULTS, displayOptions} from '../../src/lib/settings_model.js';
import {indicatorModel} from '../../src/lib/indicator_model.js';
import {menuModel} from '../../src/lib/menu_model.js';
import {
    initialState,
    nextState,
    rebasedState,
} from '../../src/lib/scheduler.js';

const NOW = 1785000000000;
const RESET = NOW + 3600000;

// The snapshot on screen while the user edits preferences.
function sessionAt(percent, fetchedAt = NOW) {
    return {fetchedAt, session: {percent, resetsAt: RESET}};
}

test('threshold_change_reclassifies_the_current_snapshot', () => {
    const snapshot = sessionAt(85);
    const before = displayOptions(DEFAULTS);
    assertEquals(indicatorModel(snapshot, NOW, before).styleClass,
        'claudometer-warning', 'precondition: 85% warns at the defaults');
    assertEquals(menuModel(snapshot, NOW, before).sections[0].barState,
        'warning');

    // Raising the warning threshold past the shown value clears the state.
    const raised = displayOptions({...DEFAULTS, warningPercent: 90});
    const indicator = indicatorModel(snapshot, NOW, raised);
    assertEquals(indicator.styleClass, 'claudometer-normal');
    assertEquals(indicator.iconVariant, 'meter', 'alert overlay dropped');
    assertEquals(menuModel(snapshot, NOW, raised).sections[0].barState,
        'normal');

    // Lowering critical below the shown value escalates it.
    const lowered = displayOptions(
        {...DEFAULTS, warningPercent: 50, criticalPercent: 85});
    assertEquals(indicatorModel(snapshot, NOW, lowered).styleClass,
        'claudometer-critical');
    assertEquals(menuModel(snapshot, NOW, lowered).sections[0].barState,
        'critical');
});

test('indicator_style_change_applies_to_the_current_snapshot', () => {
    const snapshot = sessionAt(85);
    assertEquals(
        indicatorModel(snapshot, NOW, displayOptions(DEFAULTS)).labelText,
        '85%', 'precondition: default style shows the label');

    const iconOnly = indicatorModel(snapshot, NOW,
        displayOptions({...DEFAULTS, indicatorStyle: 'icon-only'}));
    assertEquals(iconOnly.labelText, null);
    assertEquals(iconOnly.iconVariant, 'meter-alert');

    const percentOnly = indicatorModel(snapshot, NOW,
        displayOptions({...DEFAULTS, indicatorStyle: 'percent-only'}));
    assertEquals(percentOnly.labelText, '85%');
    assertEquals(percentOnly.iconVariant, null);
});

test('headline_metric_change_repins_the_panel_headline', () => {
    const snapshot = {
        fetchedAt: NOW,
        session: {percent: 30, resetsAt: RESET},
        week: {percent: 85, resetsAt: RESET},
    };
    assertEquals(
        indicatorModel(snapshot, NOW, displayOptions(DEFAULTS)).labelText,
        '85%', 'auto headlines the constraint');
    const pinned = indicatorModel(snapshot, NOW,
        displayOptions({...DEFAULTS, headlineMetric: 'session'}));
    assertEquals(pinned.labelText, '30%');
    assertEquals(pinned.styleClass, 'claudometer-normal');
});

test('refresh_interval_change_moves_the_stale_boundary', () => {
    // A 2.5-min-old snapshot is fresh at the 60 s cadence (stale after
    // 3 min) but stale once the cadence drops to 30 s (stale after 90 s).
    const aged = sessionAt(85, NOW - 150000);
    const atDefault = displayOptions(DEFAULTS);
    assertEquals(indicatorModel(aged, NOW, atDefault).styleClass,
        'claudometer-warning');
    assertEquals(menuModel(aged, NOW, atDefault).footer.stale, false);

    const fast = displayOptions({...DEFAULTS, refreshIntervalSec: 30});
    assertEquals(indicatorModel(aged, NOW, fast).styleClass,
        'claudometer-stale');
    assertEquals(menuModel(aged, NOW, fast).footer.stale, true);
});

test('refresh_interval_change_rebases_the_scheduler_state_machine', () => {
    let state = initialState(DEFAULTS.refreshIntervalSec);
    assertEquals(state.delaySec, 60);
    state = rebasedState(state, 600);
    assertEquals(state.delaySec, 600, 'next tick honors the new cadence');
    state = nextState(state, 'failure');
    assertEquals(state.delaySec, 600,
        'backoff floors at the new base, not the old one');
});

runTests();
