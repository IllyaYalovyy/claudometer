// Unit tests for src/lib/snapshot.js: raw ~/.claude.json text -> the
// UsageSnapshot display contract (designs/UX-DESIGN.md §2), with the
// honesty rules of UX §1 and the strict schema tripwire of RFC-001.
// The happy-path ground truth is the real sanitized capture committed
// under tests/fixtures/ (fabricated shapes are forbidden); degraded-path
// cases are mutations of that capture.
import GLib from 'gi://GLib';

import {test, assertEquals, runTests} from '../harness.js';
import {
    parseSnapshot,
    NOT_INSTALLED,
    NOT_AUTHENTICATED,
    UNPARSEABLE,
} from '../../src/lib/snapshot.js';

// run-tests.sh runs from the repository root.
const [, fixtureBytes] = GLib.file_get_contents(
    'tests/fixtures/cached-usage-utilization.json');
const fixtureText = new TextDecoder().decode(fixtureBytes);

const NOW = 1785000000000;
const FIXTURE_FETCHED_AT = 1784959900803;
// Fixture reset instants, built via Date.UTC rather than the parser's own
// string path. Sub-millisecond fraction digits in the capture are truncated.
const SESSION_RESET = Date.UTC(2026, 6, 25, 10, 39, 59, 696);
const WEEK_RESET = Date.UTC(2026, 6, 26, 22, 59, 59, 696);

function fixturePayload() {
    return JSON.parse(fixtureText);
}

// The parser consumes the whole ~/.claude.json text; the fixture captures
// only its cachedUsageUtilization key, so tests re-wrap it.
function wrap(payload) {
    return JSON.stringify({cachedUsageUtilization: payload});
}

function mutated(mutate) {
    const payload = fixturePayload();
    mutate(payload);
    return wrap(payload);
}

function limitOfKind(payload, kind) {
    return payload.utilization.limits.find(l => l.kind === kind);
}

function assertErrorOnly(snapshot, error, label) {
    assertEquals(snapshot.error, error, `${label}: error`);
    assertEquals(snapshot.fetchedAt, NOW, `${label}: fetchedAt`);
    for (const key of ['session', 'week', 'weekModel'])
        assertEquals(key in snapshot, false, `${label}: no fabricated ${key}`);
}

test('parses_the_real_fixture_into_all_three_windows', () => {
    const snap = parseSnapshot(wrap(fixturePayload()), NOW);

    assertEquals('error' in snap, false, 'no error field on success');
    assertEquals(snap.fetchedAt, FIXTURE_FETCHED_AT,
        'fetchedAt comes from the payload, not from now');
    assertEquals(snap.session.percent, 27);
    assertEquals(snap.session.resetsAt, SESSION_RESET);
    assertEquals(snap.week.percent, 34);
    assertEquals(snap.week.resetsAt, WEEK_RESET);
    assertEquals(snap.weekModel.length, 1);
    assertEquals(snap.weekModel[0].model, 'Fable');
    assertEquals(snap.weekModel[0].percent, 17);
    assertEquals(snap.weekModel[0].resetsAt, WEEK_RESET);
});

test('omits_each_window_the_payload_does_not_carry', () => {
    const cases = [
        {keep: ['session'], present: ['session'], absent: ['week', 'weekModel']},
        {keep: ['weekly_all'], present: ['week'], absent: ['session', 'weekModel']},
        {keep: ['session', 'weekly_all'], present: ['session', 'week'], absent: ['weekModel']},
        {keep: ['weekly_scoped'], present: ['weekModel'], absent: ['session', 'week']},
    ];
    for (const {keep, present, absent} of cases) {
        const label = `keep [${keep}]`;
        const snap = parseSnapshot(mutated(p => {
            p.utilization.limits =
                p.utilization.limits.filter(l => keep.includes(l.kind));
        }), NOW);
        assertEquals('error' in snap, false, label);
        for (const key of present)
            assertEquals(key in snap, true, `${label}: ${key} present`);
        for (const key of absent)
            assertEquals(key in snap, false,
                `${label}: ${key} absent, never defaulted`);
    }
});

test('empty_limits_yield_a_windowless_snapshot_not_an_error', () => {
    const snap = parseSnapshot(mutated(p => {
        p.utilization.limits = [];
    }), NOW);
    assertEquals('error' in snap, false);
    assertEquals(snap.fetchedAt, FIXTURE_FETCHED_AT);
    for (const key of ['session', 'week', 'weekModel'])
        assertEquals(key in snap, false, `${key} absent`);
});

test('ignores_unknown_limit_kinds_without_validating_their_fields', () => {
    // Forward compatibility (RFC-001 Design): a future window kind must not
    // break parsing, even if its fields would fail this parser's schema.
    const snap = parseSnapshot(mutated(p => {
        p.utilization.limits.push(
            {kind: 'daily_novel', percent: 'lots', resets_at: 42});
    }), NOW);
    assertEquals('error' in snap, false);
    assertEquals(snap.session.percent, 27);
    assertEquals(snap.week.percent, 34);
    assertEquals(snap.weekModel.length, 1);
});

test('zero_percent_is_a_present_value_not_a_missing_one', () => {
    const snap = parseSnapshot(mutated(p => {
        limitOfKind(p, 'session').percent = 0;
    }), NOW);
    assertEquals('session' in snap, true);
    assertEquals(snap.session.percent, 0);
});

test('normalizes_out_of_range_percents_into_the_display_range', () => {
    const cases = [[0, 0], [100, 100], [150, 100], [-3, 0], [27.5, 27.5]];
    for (const [rawPercent, expected] of cases) {
        const snap = parseSnapshot(mutated(p => {
            limitOfKind(p, 'session').percent = rawPercent;
        }), NOW);
        assertEquals(snap.session.percent, expected, `percent ${rawPercent}`);
    }
});

test('non_numeric_percent_is_schema_drift_not_a_guess', () => {
    const cases = [['string', '27'], ['null', null], ['missing', undefined]];
    for (const [label, rawPercent] of cases) {
        const snap = parseSnapshot(mutated(p => {
            const session = limitOfKind(p, 'session');
            if (rawPercent === undefined)
                delete session.percent;
            else
                session.percent = rawPercent;
        }), NOW);
        assertErrorOnly(snap, UNPARSEABLE, `percent ${label}`);
    }
});

test('reset_times_resolve_identically_across_utc_offsets', () => {
    const cases = [
        ['2026-07-25T10:39:59.696056+00:00', SESSION_RESET],
        ['2026-07-25T03:39:59.696056-07:00', SESSION_RESET],
        ['2026-07-25T12:39:59.696056+02:00', SESSION_RESET],
        ['2026-07-25T10:39:59.696Z', SESSION_RESET],
        ['2026-07-25T10:39:59.5Z', Date.UTC(2026, 6, 25, 10, 39, 59, 500)],
        ['2026-07-25T10:39:59Z', Date.UTC(2026, 6, 25, 10, 39, 59, 0)],
    ];
    for (const [resetsAt, expected] of cases) {
        const snap = parseSnapshot(mutated(p => {
            limitOfKind(p, 'session').resets_at = resetsAt;
        }), NOW);
        assertEquals(snap.session.resetsAt, expected, resetsAt);
    }
});

test('prose_or_malformed_reset_times_are_unparseable', () => {
    // The CLI's human-formatted prose dates are exactly what RFC-001
    // forbids parsing; only strict ISO 8601 with an explicit offset counts.
    const cases = [
        'Jul 25, 3:39am (America/Los_Angeles)',
        '2026-07-25',
        '2026-07-25T10:39:59',
        '2026-13-45T99:99:99.000Z',
        123,
        null,
        undefined,
    ];
    for (const resetsAt of cases) {
        const snap = parseSnapshot(mutated(p => {
            const session = limitOfKind(p, 'session');
            if (resetsAt === undefined)
                delete session.resets_at;
            else
                session.resets_at = resetsAt;
        }), NOW);
        assertErrorOnly(snap, UNPARSEABLE, `resets_at ${String(resetsAt)}`);
    }
});

test('garbage_input_yields_unparseable_never_a_fabricated_snapshot', () => {
    const cases = [
        ['empty string', ''],
        ['whitespace', '   '],
        ['not JSON', 'not-json{{{'],
        ['truncated file', wrap(fixturePayload()).slice(0, 120)],
        ['array root', '[]'],
        ['null root', 'null'],
        ['string root', '"text"'],
        ['number root', '42'],
        ['raw is null', null],
        ['raw is undefined', undefined],
        ['raw is a number', 12],
        ['raw is an object', {}],
    ];
    for (const [label, raw] of cases)
        assertErrorOnly(parseSnapshot(raw, NOW), UNPARSEABLE, label);
});

test('absent_or_null_cache_key_reads_as_not_authenticated', () => {
    // RFC-001 taxonomy: file exists but carries no utilization cache —
    // covers signed-out and API-key-only setups (NG2).
    const cases = [
        ['empty object', '{}'],
        ['null key', '{"cachedUsageUtilization": null}'],
        ['unrelated keys only', '{"numStartups": 5}'],
    ];
    for (const [label, raw] of cases)
        assertErrorOnly(parseSnapshot(raw, NOW), NOT_AUTHENTICATED, label);
});

test('wrong_typed_required_fields_are_unparseable', () => {
    const cases = [
        ['cache key is a string', () => '{"cachedUsageUtilization": "soon"}'],
        ['cache key is an array', () => '{"cachedUsageUtilization": []}'],
        ['cache key is a number', () => '{"cachedUsageUtilization": 7}'],
        ['fetchedAtMs missing', () => mutated(p => delete p.fetchedAtMs)],
        ['fetchedAtMs string', () => mutated(p => {
            p.fetchedAtMs = '1784959900803';
        })],
        ['fetchedAtMs fractional', () => mutated(p => {
            p.fetchedAtMs = 1.5;
        })],
        ['fetchedAtMs negative', () => mutated(p => {
            p.fetchedAtMs = -1;
        })],
        ['utilization missing', () => mutated(p => delete p.utilization)],
        ['utilization null', () => mutated(p => {
            p.utilization = null;
        })],
        ['limits missing', () => mutated(p => delete p.utilization.limits)],
        ['limits not an array', () => mutated(p => {
            p.utilization.limits = {};
        })],
        ['limit entry not an object', () => mutated(p => {
            p.utilization.limits = [42];
        })],
        ['limit entry null', () => mutated(p => {
            p.utilization.limits = [null];
        })],
        ['kind missing', () => mutated(p => {
            delete limitOfKind(p, 'session').kind;
        })],
        ['kind not a string', () => mutated(p => {
            limitOfKind(p, 'session').kind = 5;
        })],
    ];
    for (const [label, buildRaw] of cases)
        assertErrorOnly(parseSnapshot(buildRaw(), NOW), UNPARSEABLE, label);
});

test('one_malformed_consumed_entry_poisons_the_whole_snapshot', () => {
    // Strict over partial (RFC-001 drift tripwire): a wrong-typed consumed
    // field means the schema drifted, and no field of a drifted payload can
    // be trusted — even ones that still look well-formed.
    const snap = parseSnapshot(mutated(p => {
        limitOfKind(p, 'weekly_all').percent = '34';
    }), NOW);
    assertErrorOnly(snap, UNPARSEABLE, 'valid session + malformed week');
});

test('weekly_scoped_requires_a_model_display_name', () => {
    const cases = [
        ['scope null', s => {
            s.scope = null;
        }],
        ['model null', s => {
            s.scope.model = null;
        }],
        ['display_name null', s => {
            s.scope.model.display_name = null;
        }],
        ['display_name empty', s => {
            s.scope.model.display_name = '';
        }],
    ];
    for (const [label, mutateScoped] of cases) {
        const snap = parseSnapshot(mutated(p => {
            mutateScoped(limitOfKind(p, 'weekly_scoped'));
        }), NOW);
        assertErrorOnly(snap, UNPARSEABLE, label);
    }
});

test('exports_the_failure_taxonomy_as_stable_strings', () => {
    // Journal/log vocabulary shared with the fetcher (RFC-001 taxonomy);
    // renaming a constant's value is a cross-module breaking change.
    assertEquals(NOT_INSTALLED, 'not-installed');
    assertEquals(NOT_AUTHENTICATED, 'not-authenticated');
    assertEquals(UNPARSEABLE, 'unparseable');
});

runTests();
