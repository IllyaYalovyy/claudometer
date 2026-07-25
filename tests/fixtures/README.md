# Test fixtures

Real, sanitized captures of the usage data sources evaluated in
`designs/RFC-001-usage-data-source.md`. These are the ground truth for
parser tests: fabricated fixtures that do not match a verified capture are
forbidden (see the `test-quality` skill).

## Provenance

Captured 2026-07-24 on Claude Code CLI **2.1.220** (`claude --version`),
Linux, subscription plan. Capture commands are documented per fixture
below; the full probe log is in RFC-001's Q1/Q2 evidence.

## Sanitization applied

- All UUIDs (`accountUuid`, `session_id`, `uuid`) replaced with the zero
  UUID.
- Local skill names inside the human-readable `result` text replaced with
  `/example-skill-*` placeholders.
- Everything else (field names, value types, formatting, timestamps,
  percentages) is byte-faithful to the real output.

## Fixtures

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
