// IO layer for RFC-001 Option C: async reads of the ~/.claude.json cache
// (the only parse surface) and the injectable `claude` refresh spawn. No
// Shell imports; importable under plain `gjs -m`. All schema decisions
// stay in snapshot.js — this module only moves bytes and maps every IO
// failure into the RFC-001 taxonomy. When and whether to call these
// functions (poll cadence, staleness, backoff, disabling the refresh path
// on MODEL_INVOKED) is the scheduler's job, not this module's.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseSnapshot, NOT_INSTALLED, UNPARSEABLE} from './snapshot.js';

// Refresh outcomes beyond the parser's taxonomy (RFC-001 Design):
// REFRESH_FAILED covers the transient spawn failures backoff handles;
// MODEL_INVOKED is the fail-closed G1 tripwire — a structurally valid CLI
// envelope on which the zero-cost invariants cannot be asserted, the one
// signal that must permanently disable the refresh path.
export const REFRESH_FAILED = 'refresh-failed';
export const MODEL_INVOKED = 'model-invoked';

// The RFC-001 source: the cache file as parse surface, the proven
// token-free CLI command as refresh trigger. Injectable so tests (and a
// future preference) can substitute both. The timeout is far above the
// observed 264–321 ms envelope runs but safely below the 60 s poll tick.
export function defaultConfig() {
    return {
        filePath: GLib.build_filenamev([GLib.get_home_dir(), '.claude.json']),
        refreshArgv: ['claude', '-p', '/usage', '--output-format', 'json'],
        refreshTimeoutMs: 30000,
    };
}

class FetchError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Async read of the raw cache-file text. Rejects with a FetchError whose
// `code` is a taxonomy value: an absent file means Claude Code never ran
// here (NOT_INSTALLED); any other IO failure means the source exists but
// cannot be read — UNPARSEABLE, exact cause in the error message for the
// journal.
export function fetchRaw(config) {
    const {filePath} = {...defaultConfig(), ...config};
    return new Promise((resolve, reject) => {
        const file = Gio.File.new_for_path(filePath);
        file.load_contents_async(null, (source, result) => {
            try {
                const [, bytes] = source.load_contents_finish(result);
                resolve(new TextDecoder().decode(bytes));
            } catch (e) {
                const code = e instanceof GLib.Error &&
                    e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)
                    ? NOT_INSTALLED
                    : UNPARSEABLE;
                reject(new FetchError(code, `reading ${filePath}: ${e.message}`));
            }
        });
    });
}

// Read + parse in one step: always resolves to a UsageSnapshot (error
// snapshots included) so a fetch can never throw into the caller's
// mainloop.
export async function fetchSnapshot(config, now) {
    let raw;
    try {
        raw = await fetchRaw(config);
    } catch (e) {
        return {fetchedAt: now, error: e.code};
    }
    return parseSnapshot(raw, now);
}

// G1 tripwire (RFC-001 drift detection 2): the envelope must positively
// assert zero model involvement. Wrong-typed or missing counters fail the
// assertion too — `"0" !== 0` — because an envelope that cannot prove
// zero cost must not be trusted as zero cost.
const ZERO_USAGE_KEYS = [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
];

function assertsZeroCost(envelope) {
    if (envelope.num_turns !== 0 || envelope.duration_api_ms !== 0 ||
        envelope.total_cost_usd !== 0)
        return false;
    if (!isPlainObject(envelope.modelUsage) ||
        Object.keys(envelope.modelUsage).length > 0)
        return false;
    if (!isPlainObject(envelope.usage))
        return false;
    return ZERO_USAGE_KEYS.every(key => envelope.usage[key] === 0);
}

// The CLI's stdout is a health signal only — never a data source (RFC-001
// Design). Non-JSON output is transient breakage for backoff to absorb;
// a real envelope failing the zero-cost assertion is the tripwire.
function classifyEnvelope(stdoutText) {
    let envelope;
    try {
        envelope = JSON.parse(stdoutText);
    } catch {
        return {ok: false, error: REFRESH_FAILED, reason: 'bad-envelope'};
    }
    if (!isPlainObject(envelope))
        return {ok: false, error: REFRESH_FAILED, reason: 'bad-envelope'};
    if (!assertsZeroCost(envelope))
        return {ok: false, error: MODEL_INVOKED};
    if (envelope.is_error !== false)
        return {ok: false, error: REFRESH_FAILED, reason: 'cli-error'};
    return {ok: true};
}

// Spawn the refresh command asynchronously and resolve — never reject —
// with {ok: true} or {ok: false, error, reason?}. The caller re-reads the
// file afterwards; nothing from the spawn is parsed into usage data. A
// hang is SIGKILLed at the timeout, and the promise resolves only after
// communicate() finishes, so the child is reaped before anyone observes
// the result (no leaked GSubprocess).
export function refreshCache(config) {
    const {refreshArgv, refreshTimeoutMs} = {...defaultConfig(), ...config};
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(refreshArgv,
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            if (e instanceof GLib.Error &&
                e.matches(GLib.SpawnError, GLib.SpawnError.NOENT))
                resolve({ok: false, error: NOT_INSTALLED});
            else
                resolve({ok: false, error: REFRESH_FAILED, reason: 'spawn-failed'});
            return;
        }
        let timedOut = false;
        let timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, refreshTimeoutMs, () => {
                timedOut = true;
                timeoutId = 0;
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
        proc.communicate_utf8_async(null, null, (source, result) => {
            if (timeoutId !== 0)
                GLib.source_remove(timeoutId);
            let stdout = null;
            try {
                [, stdout] = source.communicate_utf8_finish(result);
            } catch {
                stdout = null;
            }
            if (timedOut)
                resolve({ok: false, error: REFRESH_FAILED, reason: 'timeout'});
            else if (!source.get_if_exited() || source.get_exit_status() !== 0)
                resolve({ok: false, error: REFRESH_FAILED, reason: 'nonzero-exit'});
            else
                resolve(classifyEnvelope(stdout ?? ''));
        });
    });
}
