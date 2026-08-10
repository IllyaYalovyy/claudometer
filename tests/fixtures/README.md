# Test fixtures

Real, sanitized captures of the usage data sources evaluated in RFC-001 and
RFC-002. These are the ground truth for
parser tests: fabricated fixtures that do not match a verified capture are
forbidden (see the `test-quality` skill).

## Provenance

Claude fixtures were captured 2026-07-24 on Claude Code CLI **2.1.220**
(`claude --version`), Linux, subscription plan. Codex fixtures were captured
2026-08-09 on Codex CLI **0.147.0** through the documented App Server method.
Capture commands are documented per fixture below.

## Sanitization applied

- All UUIDs (`accountUuid`, `session_id`, `uuid`) replaced with the zero
  UUID.
- Local skill names inside the human-readable `result` text replaced with
  `/example-skill-*` placeholders.
- Everything else (field names, value types, formatting, timestamps,
  percentages) is byte-faithful to the real output.

## Fixtures

### `codex-rate-limits-result.json` / `codex-app-server-response.json`

The consumed projection of a live `account/rateLimits/read` response, and the
same value inside its matching JSON-RPC response envelope. The probe sent only
`initialize`, `initialized`, and `account/rateLimits/read`; it started no
thread or turn. Unconsumed account/credit fields were removed rather than
committed. The remaining bucket ids, names, percentages, durations, reset
timestamps, nullability, and backend map order are capture-faithful. The map
intentionally arrives model-specific first; parser tests prove the UI's stable
general-before-model ordering.

### `cached-usage-utilization.json`

The value of the top-level `cachedUsageUtilization` key of `~/.claude.json`
(the whole file is ~96 KB and contains unrelated account/project state; only
this key is relevant and only this key is captured). Written by the Claude
Code CLI after it fetches plan utilization. The fields the extension
consumes:

- `fetchedAtMs` — epoch ms of the fetch; the freshness signal. Verified
  (RFC-001 Q2 evidence) that failed/offline refreshes do *not* advance it.
- `utilization.limits[]` — one entry per rate-limit window:
  `kind` (`session` | `weekly_all` | `weekly_scoped`), `percent`,
  `severity`, `resets_at` (ISO 8601 with offset), `is_active`,
  `scope.model.display_name` for per-model windows.
- `utilization.five_hour` / `utilization.seven_day` — same data in an
  older summary shape; `limits[]` is the more complete surface.

### `claude-p-usage-result.json`

Full stdout of:

```bash
claude -p "/usage" --output-format json
```

run outside any project directory. This is the RFC-001 Q1 zero-token-cost
evidence: `num_turns: 0`, `duration_api_ms: 0`, `total_cost_usd: 0`, all
`usage` counters zero, `modelUsage: {}` — the slash command is handled by
the CLI without any model call. The `result` field is human-formatted text
(locale/timezone-dependent), not a stable machine contract; the structured
cache above is the parse surface.

`scripts/quality.d/50-fixtures` re-asserts these invariants on every
quality-gate run so the committed evidence cannot silently rot.

### `claude-p-usage-signed-out.json`

Full stdout of the same command run **signed out**, captured 2026-07-25 on
CLI **2.1.220** with `CLAUDE_CONFIG_DIR` pointed at an empty temporary
directory (so no credentials exist and no billed call is possible):

```bash
CLAUDE_CONFIG_DIR=$(mktemp -d) claude -p "/usage" --output-format json
```

Findings that shaped the fetcher (`src/lib/fetcher.js`): the signed-out CLI
exits **0** with `is_error: false` and an all-zero envelope — there is no
distinguishable auth-error envelope shape on this CLI version — and it does
**not** create `cachedUsageUtilization`. The `result` field is a generic
cost report instead of the usage report. `NOT_AUTHENTICATED` is therefore
detected on the file surface (cache key absent, RFC-001 taxonomy), never
from CLI output.

## Fake executables (`bin/`)

Shell scripts standing in for the `claude` binary in fetcher/source unit
tests (the refresh argv is injectable, RFC-001 Design). Each simulates one
failure mode: `emit-file` prints a captured envelope, `emit-garbage` prints
non-JSON, `exit-nonzero` fails outright, `hang` records its PID and sleeps
so the timeout kill can be proven, and `record-refresh` counts its spawns
in a run log and optionally installs a cache file the way the real CLI
rewrites `~/.claude.json`. They are test doubles, not captures.
