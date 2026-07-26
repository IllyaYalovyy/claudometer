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
// future preference) can substitute both; the bare `claude` is resolved
// to an absolute path at spawn time (resolveCli). The timeout is far
// above the observed 264–321 ms envelope runs but safely below the 60 s
// poll tick.
export function defaultConfig() {
    return {
        filePath: GLib.build_filenamev([GLib.get_home_dir(), '.claude.json']),
        refreshArgv: ['claude', '-p', '/usage', '--output-format', 'json'],
        refreshTimeoutMs: 30000,
    };
}

// GNOME Shell's PATH is a session manager's, not a login shell's, so a
// user-level `claude` install (npm prefix, installer script) may be
// invisible to a bare execvp lookup even though a terminal finds it. A
// bare command is therefore resolved here: each PATH dir first, then the
// common user-install dirs ~/.local/bin and ~/bin. A hit is an executable
// regular file; empty PATH entries (cwd by tradition) are never resolved.
// Inputs are injectable so tests can point it at fake bin dirs. Returns
// the absolute path of the first hit, or null when every candidate
// misses.
export function resolveCli(name, {
    pathEnv = GLib.getenv('PATH') ?? '',
    home = GLib.get_home_dir(),
} = {}) {
    const dirs = [
        ...pathEnv.split(':').filter(dir => dir !== ''),
        GLib.build_filenamev([home, '.local', 'bin']),
        GLib.build_filenamev([home, 'bin']),
    ];
    for (const dir of dirs) {
        const candidate = GLib.build_filenamev([dir, name]);
        if (GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE) &&
            GLib.file_test(candidate, GLib.FileTest.IS_REGULAR))
            return candidate;
    }
    return null;
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
// with {ok: true} or {ok: false, error, reason?, command}. A bare command
// name is first resolved through resolveCli (config.cliSearch feeds it);
// no hit anywhere is NOT_INSTALLED without spawning. Every failure names
// the `command` it tried so the journal can say which path failed. The
// caller re-reads the file afterwards; nothing from the spawn is parsed
// into usage data. A hang is SIGKILLed at the timeout, and the promise
// resolves only after communicate() finishes, so the child is reaped
// before anyone observes the result (no leaked GSubprocess).
export function refreshCache(config) {
    const {refreshArgv, refreshTimeoutMs, cliSearch} =
        {...defaultConfig(), ...config};
    const argv = [...refreshArgv];
    if (!argv[0].includes('/')) {
        const resolved = resolveCli(argv[0], cliSearch);
        if (resolved === null)
            return Promise.resolve(
                {ok: false, error: NOT_INSTALLED, command: argv[0]});
        argv[0] = resolved;
    }
    const command = argv[0];
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            if (e instanceof GLib.Error &&
                e.matches(GLib.SpawnError, GLib.SpawnError.NOENT))
                resolve({ok: false, error: NOT_INSTALLED, command});
            else
                resolve({ok: false, error: REFRESH_FAILED,
                    reason: 'spawn-failed', command});
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
            if (timedOut) {
                resolve({ok: false, error: REFRESH_FAILED,
                    reason: 'timeout', command});
            } else if (!source.get_if_exited() ||
                       source.get_exit_status() !== 0) {
                resolve({ok: false, error: REFRESH_FAILED,
                    reason: 'nonzero-exit', command});
            } else {
                const verdict = classifyEnvelope(stdout ?? '');
                resolve(verdict.ok ? verdict : {...verdict, command});
            }
        });
    });
}
