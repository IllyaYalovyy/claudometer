// RFC-002 source composition. Provider reads are independent and concurrent;
// an unavailable Codex installation never hides a healthy Claude snapshot (or
// vice versa), and the scheduler still sees one never-rejecting fetch contract.

export class MultiUsageSource {
    constructor({claude, codex}) {
        this._claude = claude;
        this._codex = codex;
    }

    get lastRefreshFailed() {
        return this._claude.lastRefreshFailed || this._codex.lastRefreshFailed;
    }

    get lastRefreshFailedByProvider() {
        return {
            claude: this._claude.lastRefreshFailed,
            codex: this._codex.lastRefreshFailed,
        };
    }

    async fetch(now, opts = {}) {
        const [claude, codex] = await Promise.all([
            this._claude.fetch(now, opts),
            this._codex.fetch(now, opts),
        ]);
        return {providers: {claude, codex}};
    }
}
