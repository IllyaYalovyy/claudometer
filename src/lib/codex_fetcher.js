// Async RFC-002 adapter for the documented Codex App Server account read.
// It starts a short-lived stdio server, performs only the initialization
// handshake and account/rateLimits/read, then force-exits and reaps it. No
// thread, turn, auth mutation, credit, or reset method is ever sent.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {resolveCli} from './fetcher.js';
import {NOT_INSTALLED} from './snapshot.js';
import {parseCodexRateLimits} from './codex_snapshot.js';

export const CODEX_READ_FAILED = 'codex-read-failed';
const REQUEST_ID = 2;

export function defaultCodexConfig() {
    return {
        appServerArgv: ['codex', 'app-server'],
        timeoutMs: 15000,
    };
}

function failure(now, reason, command = null) {
    return {
        fetchedAt: now,
        error: CODEX_READ_FAILED,
        reason,
        ...(command === null ? {} : {command}),
    };
}

function requestText() {
    return [
        {
            method: 'initialize',
            id: 0,
            params: {clientInfo: {
                name: 'claudometer',
                title: 'Claudometer',
                version: '0.1.0',
            }},
        },
        {method: 'initialized', params: {}},
        {method: 'account/rateLimits/read', id: REQUEST_ID},
    ].map(message => JSON.stringify(message)).join('\n') + '\n';
}

// Always resolves to a Codex provider snapshot. The response reader accepts
// notifications and initialization responses before the matching quota reply;
// any malformed protocol line fails closed instead of guessing at usage.
export function fetchCodexSnapshot(config, now) {
    const {appServerArgv, timeoutMs, cliSearch} =
        {...defaultCodexConfig(), ...config};
    const argv = [...appServerArgv];
    if (!argv[0].includes('/')) {
        const resolved = resolveCli(argv[0], cliSearch);
        if (resolved === null) {
            return Promise.resolve({
                fetchedAt: now,
                error: NOT_INSTALLED,
                command: argv[0],
            });
        }
        argv[0] = resolved;
    }
    const command = argv[0];

    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            const notFound = e instanceof GLib.Error &&
                e.matches(GLib.SpawnError, GLib.SpawnError.NOENT);
            resolve(notFound
                ? {fetchedAt: now, error: NOT_INSTALLED, command}
                : failure(now, 'spawn-failed', command));
            return;
        }

        const input = proc.get_stdin_pipe();
        const output = new Gio.DataInputStream({
            base_stream: proc.get_stdout_pipe(),
        });
        let settled = false;
        let timeoutId = 0;

        const settle = snapshot => {
            if (settled)
                return;
            settled = true;
            if (timeoutId !== 0) {
                GLib.source_remove(timeoutId);
                timeoutId = 0;
            }
            try {
                input.close(null);
            } catch {
                // The child may already have closed its side.
            }
            try {
                proc.force_exit();
            } catch {
                // Already exited is fine; wait_async below still reaps it.
            }
            proc.wait_async(null, (source, result) => {
                try {
                    source.wait_finish(result);
                } catch {
                    // Snapshot taxonomy, not a rejected promise, owns failure.
                }
                try {
                    output.close(null);
                } catch {
                    // The process may have closed stdout first.
                }
                resolve(snapshot);
            });
        };

        const readNext = () => {
            output.read_line_async(GLib.PRIORITY_DEFAULT, null,
                (stream, result) => {
                    if (settled)
                        return;
                    let bytes;
                    try {
                        [bytes] = stream.read_line_finish(result);
                    } catch {
                        settle(failure(now, 'read-failed', command));
                        return;
                    }
                    if (bytes === null) {
                        settle(failure(now, 'early-eof', command));
                        return;
                    }
                    let message;
                    try {
                        message = JSON.parse(new TextDecoder().decode(bytes));
                    } catch {
                        settle(failure(now, 'bad-json', command));
                        return;
                    }
                    if (message?.id !== REQUEST_ID) {
                        readNext();
                        return;
                    }
                    if (message.error !== undefined ||
                        message.result === undefined) {
                        settle(failure(now, 'server-error', command));
                        return;
                    }
                    settle(parseCodexRateLimits(message.result, now));
                });
        };

        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            timeoutId = 0;
            settle(failure(now, 'timeout', command));
            return GLib.SOURCE_REMOVE;
        });

        try {
            input.write_all(new TextEncoder().encode(requestText()), null);
        } catch {
            settle(failure(now, 'write-failed', command));
            return;
        }
        readNext();
    });
}
