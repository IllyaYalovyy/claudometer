# RFC-001: Usage Data Source

| Field | Value |
|---|---|
| Status | Review |
| Author(s) | Illya Yalovyy |
| Supersedes | - |
| Superseded by | - |

## Summary

Claudometer needs to read Claude Code's token/usage state from GNOME Shell
without ever spending a token or model call to do so. This RFC picks where
that data comes from and how it is fetched.

**Decision (2026-07-24): Option C — hybrid.** The structured
`cachedUsageUtilization` object in `~/.claude.json` is the read surface;
`claude -p "/usage" --output-format json` (proven to make zero model calls
on CLI 2.1.220) is the refresh trigger when that cache is stale. Evidence
inline below; sanitized captures are committed under `tests/fixtures/`.

## Goals

- **G1** - Never invoke the model to learn about model usage. Zero API spend
  attributable to the extension itself, always.
- **G2** - Data is fresh enough for an ambient panel indicator (seconds to a
  couple of minutes of staleness is acceptable; sub-second is not required).
- **G3** - Works without requiring the user to configure an API key inside
  the extension — it should reuse whatever Claude Code is already
  authenticated with locally.

## Non-Goals

- **NG1** - Historical analytics/dashboards beyond what the panel dropdown
  needs.
- **NG2** - API-key (pay-per-token) usage reporting. **Ratified by user
  decision 2026-07-24: Claudometer targets subscription plans and their
  rate-limit windows only.** API metering is a different product; an
  API-key-only setup renders as the unavailable state (see
  `UX-DESIGN.md` Scope note).

## Background and Motivation

The CLI's interactive `/usage` slash command prints current plan usage
(session tokens, rolling 5-hour and weekly windows, reset times). The
original idea in the project brief was to shell out to:

```bash
claude -p "/usage" --output-format json
```

Probing on 2026-07-24 (CLI **2.1.220**, Linux, subscription plan) found
**three** local sources of Claude Code usage state, not two:

1. **`claude -p "/usage" --output-format json`.** Handled entirely by the
   CLI — verified, see Q1 evidence. Returns live window percentages and
   reset times, but as human-formatted text inside the JSON envelope.
2. **`~/.claude/stats-cache.json`.** Historical accounting only — verified,
   see Q2 evidence. Carries no rolling-window or reset-time data.
3. **`~/.claude.json`, top-level key `cachedUsageUtilization`.** A
   structured cache of exactly the rolling-window data the UI contract
   needs (per-window percent, ISO reset times, severity, per-model scope),
   with an explicit `fetchedAtMs` freshness stamp. Written by the CLI when
   it fetches plan utilization. Discovered while answering Q2; this is the
   surface the original two-option framing was missing.

None of these shapes are contractually documented; all are internal Claude
Code implementation details that could change between CLI versions. The
Design section below therefore treats schema drift as a first-class failure
mode, not an edge case.

## User Impact

| Audience | Impact |
|---|---|
| End users | See accurate, near-real-time usage with no token cost, or a clear "unavailable" state if Claude Code's local state can't be read. |
| Contributors | The data source is the one dependency most likely to break on a Claude Code update; it needs a documented fallback/detection strategy. |
| Operators / packagers | No network permissions or credentials needed beyond local filesystem/process access. |

## Considered Options

### Option A - Shell out to `claude -p "/usage" --output-format json`

**Pros**: Proven zero-model-call on 2.1.220 (Q1); always fetches live
server-side utilization when online; CLI owns auth.

**Cons**: The data arrives as English, locale/timezone-formatted prose in
the `result` field — not a machine contract; parsing reset times like
`Jul 25, 3:39am (America/Los_Angeles)` is drift-prone. When offline, the
CLI exits 0 and renders last-known values with **no staleness marker**
(verified, Q1 evidence), so this path cannot self-report freshness.
Process spawn per poll (~300 ms each) and a metadata fetch against
Anthropic's usage endpoint per spawn (rate-limit exposure; the CLI
changelog documents the endpoint being rate-limited).

### Option B - Read local files under `~/.claude*` directly

**Pros**: Plain file read; `cachedUsageUtilization` is structured (percent,
ISO `resets_at`, severity, per-model scope — a superset of the
`UX-DESIGN.md` §2 `UsageSnapshot` contract) and carries an honest
`fetchedAtMs` that failed fetches do not advance (verified). ~96 KB file,
~1 ms to parse. Zero-cost by construction.

**Cons**: The cache's refresh cadence is owned by Claude Code, not the
extension — observed 26 minutes stale *during* an active heavy session,
and indefinitely stale when no session runs. Alone it cannot meet G2, and
`stats-cache.json` (the file the original framing pointed at) has no
window data at all (Q2).

### Option C - Hybrid: read the structured cache; use the CLI only to refresh it

**Pros**: The common case is a 1 ms local file read. The CLI — proven
token-free — is spawned only when the cache is older than the user's
staleness threshold, which is exactly the condition under which the CLI
refreshes the cache (verified, Q1/Q2 freshness evidence). All data parsing
happens against the structured cache; the CLI's prose output is never
parsed for data, only its JSON envelope checked as a health signal.

**Cons**: Two moving parts; the refresh path depends on the CLI continuing
to write the cache when it is stale (an internal behavior that must be
re-verified on CLI upgrades — the failure mode degrades to visible
staleness, not wrong numbers).

## Decision

**Option C, as concretized above.** The RFC's stated decision rule was that
the option must follow from the Q1/Q2 answers, not preference. Applying it:

- Q1 answered **yes, token-free** → the CLI is usable, but its prose output
  and silent-stale offline behavior (evidence below) disqualify it as the
  *parse* surface.
- Q2 answered **stats-cache.json no; `cachedUsageUtilization` yes** → a
  structured zero-cost surface exists, but its refresh cadence alone fails
  G2.

Each source is sufficient exactly where the other is deficient: the file
gives a trustworthy machine contract with honest freshness; the CLI gives a
proven-zero-cost way to make it fresh. Neither alone satisfies G1+G2+G3;
the hybrid satisfies all three. Status moves to `Review` per the
development plan; implementation (Step 4) starts only once `Accepted`.

G1 note: the CLI refresh performs a metadata-only fetch of plan utilization
inside Claude Code's own process — no prompt, no model turn, zero tokens
(evidence below). `VISION.md` principle 1 explicitly permits metadata-only
queries; principle 3 (the extension itself talks to no network endpoint)
is preserved because the network I/O belongs to the user's own Claude Code
installation.

## Design

### Source of truth

`~/.claude.json` → top-level key `cachedUsageUtilization`. Consumed fields
(sanitized real capture: `tests/fixtures/cached-usage-utilization.json`):

- `fetchedAtMs` (integer, epoch ms) — freshness stamp for the whole
  snapshot. Maps to `UsageSnapshot.fetchedAt`.
- `utilization.limits[]` — one entry per rate-limit window:
  - `kind`: `"session"` | `"weekly_all"` | `"weekly_scoped"` (map to
    `session.*`, `week.*`, `weekModel[]` in `UX-DESIGN.md` §2)
  - `percent` (number), `resets_at` (ISO 8601 with offset)
  - `scope.model.display_name` for `weekly_scoped` entries
  - `severity`, `is_active` — available but the UI derives its own
    thresholds from `percent` (UX §3.3), so these are informational.

Unknown `kind` values and extra fields are ignored (forward-compatible);
*missing* required fields are a hard `unparseable` failure (see taxonomy).
The whole file is read read-only; nothing under `~/.claude*` is ever
written. Only this one key is extracted; the rest of `~/.claude.json`
(account/project state) is never retained in memory beyond the parse.

### Polling and refresh

- Poll tick (default 60 s, per UX §6/§7): read + parse the file (~1 ms),
  emit a `UsageSnapshot`.
- If `now - fetchedAtMs` exceeds the staleness threshold (default: the
  poll interval), spawn `claude -p "/usage" --output-format json`
  asynchronously, then re-read the file on completion. Spawns are spaced
  at least one poll interval apart and back off exponentially on failure
  (1 → 2 → 5 min cap, UX §6) to respect the usage endpoint's server-side
  rate limits.
- Manual refresh (UX §4.4) always spawns, and resets the backoff.
- A spawn after which `fetchedAtMs` still did not advance is not an error
  by itself: the CLI throttles cache writes (it skipped rewriting a
  1–3-min-old cache in probing, while rewriting 11-min- and 26-min-old
  ones). The UI keeps the last snapshot and enters the stale state only
  when the age threshold (3× poll interval, UX §3.3) is crossed. Never is
  the CLI's prose output parsed into numbers.
- **Accepted staleness bound (G2 tradeoff):** because the file is the only
  parse surface and the CLI rewrites it only past its internal throttle,
  worst-case snapshot age is that throttle — observed between ~3 and ~11
  minutes on 2.1.220 — not the 60 s poll interval. This stretches G2's
  "couple of minutes" to single-digit minutes in the worst case. Accepted
  for v1 because the UI is explicit about data age (UX §4.4) and the
  alternative — strictly parsing the percent lines out of the CLI's
  English prose as a freshness patch — buys a few minutes at the cost of a
  second, drift-prone parser. Revisit if real use shows the throttle
  growing coarser.

### Failure taxonomy

| State | Detection | UI (per UX-DESIGN) |
|---|---|---|
| not-installed | `claude` not resolvable on `PATH` (from GNOME Shell's environment) and `~/.claude.json` absent | Unavailable: "Claude Code was not found" (§4.5) |
| not-authenticated / no subscription | `~/.claude.json` exists but `cachedUsageUtilization` absent or null, and CLI refresh does not create it (covers signed-out and API-key-only setups, NG2) | Unavailable: "sign in, then refresh" (§4.5) |
| unparseable | JSON parse error, or schema validation failure (missing/wrong-typed required fields above) | Unavailable; exact cause to the journal, never to the menu (§4.5) |
| stale | `fetchedAtMs` age > 3× poll interval | Stale (dimmed last value + age in footer, §3.3/§4.4) |
| refresh-failed (offline, rate-limited) | spawn exits non-zero, times out, or exits 0 without advancing `fetchedAtMs` | stays/becomes stale; backoff engages |

### Drift detection (never silently misread)

1. **File schema tripwire**: strict validation of the consumed fields on
   every parse; any mismatch → `unparseable`, journal log with the CLI
   version (`claude --version` output is cached per session) so bug
   reports identify the drifted version. No best-effort coercion.
2. **G1 tripwire**: every CLI spawn's JSON envelope is asserted to satisfy
   `num_turns == 0 && duration_api_ms == 0 && total_cost_usd == 0 &&
   modelUsage == {}` and all-zero `usage` token counters. If a future CLI
   ever routes `/usage` through the model, the extension detects it on the
   first spawn, **permanently disables the CLI refresh path** (persisted
   flag; re-enabled only by explicit user action), surfaces the stale/
   unavailable state, and logs. Fail-closed on G1: degraded freshness is
   acceptable, spending tokens is not.
3. The committed evidence fixtures are re-validated by
   `scripts/quality.d/50-fixtures` on every quality-gate run, and the Q1
   probe must be re-run (and this RFC's evidence appended) when the
   supported CLI version range changes.

## Testing Strategy

| Risk / invariant | Test layer | Test name / location |
|---|---|---|
| Extension never triggers a model call to read usage | Gate + unit + manual | `scripts/quality.d/50-fixtures` (envelope invariants on committed evidence); unit tests for the G1-tripwire validator in `src/lib/` against `tests/fixtures/claude-p-usage-result.json` and mutated (cost > 0) variants; documented manual re-probe on CLI upgrades |
| Unavailable/unparseable data source degrades to a clear UI state, not a crash or silent wrong number | Unit (+ fuzz) | parser tests in `src/lib/` against the real fixture and mutations: missing key, null, wrong types, truncated JSON, empty file; property/fuzz per `docs/TESTING.md` for the parser |
| Stale data is shown as stale, never as fresh | Unit | staleness state machine with `now` injected as a parameter (no wall-clock reads in pure modules) |
| Polling does not leak processes/file handles over long uptime | Manual / soak | nested-GNOME-Shell soak, described in the implementing task's report |

What cannot be tested automatically: actual Claude API token accounting
correctness — that is Anthropic's backend, not this extension's code; the
extension can only be tested against the local values it reads.

## Goals Alignment

| Goal | How addressed |
|---|---|
| G1 | Both halves proven zero-cost: file read by construction; CLI spawn by direct evidence (Q1) plus a fail-closed runtime tripwire for future CLI drift. |
| G2 | File polled every 60 s; CLI refresh bounds staleness to the CLI's internal cache-write throttle (observed ≤ ~11 min on 2.1.220 — see the accepted G2 tradeoff in Design), and the UI is honest about data age beyond 3× the poll interval. |
| G3 | Both sources reuse Claude Code's own local auth/session state; the extension holds no credentials. |

## Development Plan

- [x] **Step 1** - Answer Q1 — done 2026-07-24, evidence under Q1 below.
- [x] **Step 2** - Answer Q2 — done 2026-07-24, evidence under Q2 below.
- [x] **Step 3** - Choose an option based on Step 1/2 results and fill in
  Design, then move Status to `Review` — done 2026-07-24 (this revision).
- [ ] **Step 4** - Implement the chosen data source behind a small interface
  so the option can be swapped without touching UI code. *(prerequisite: Step 3, Accepted)*

## Open Questions

- [x] **Q1** - Does `claude -p "/usage" --output-format json` ever result in
  a billed model call? **Answered 2026-07-24: no — proven on CLI 2.1.220.**

  Probes: `claude --version` → `2.1.220 (Claude Code)`. Ran
  `claude -p "/usage" --output-format json` from a non-project directory
  five times: four online (23:11, 23:12, 23:14, 23:22 local) and one with
  networking disabled via `unshare -rn`. Every run returned the same
  envelope evidence of zero model involvement:

  ```
  "num_turns": 0, "duration_api_ms": 0, "total_cost_usd": 0,
  "usage": { all token counters 0 }, "modelUsage": {}
  ```

  with total `duration_ms` 264–321 ms — far below any model round-trip.
  The `result` field is the CLI-rendered `/usage` text. Across the four
  online runs the session percentage ticked 27% → 29% → 31% → 47% while a
  heavy Claude Code session ran concurrently, confirming the values are
  live server-side utilization (a metadata fetch), not a local echo.
  Sanitized full capture: `tests/fixtures/claude-p-usage-result.json`.

  Two caveats that shaped the Design: (a) offline, the command still exits
  0 and renders the last-known values with no staleness marker anywhere in
  the output — the CLI text cannot be trusted to self-report freshness;
  (b) the offline run did *not* advance the cache's `fetchedAtMs`, so the
  file's freshness stamp stays honest.

- [x] **Q2** - Do local Claude Code files carry live rolling-window
  plan-limit and reset-time data? **Answered 2026-07-24: not
  `stats-cache.json` — but `~/.claude.json` does.**

  `~/.claude/stats-cache.json` (full field inventory, same date):
  `version`, `lastComputedDate`, `dailyActivity[]` (message/session/tool
  counts per day), `dailyModelTokens[]`, `modelUsage` (lifetime token/cost
  totals per model), `totalSessions`, `totalMessages`, `longestSession`,
  `firstSessionDate`, `hourCounts`. Purely historical; no window
  percentages, no reset times. As a `UsageSnapshot` source: insufficient.

  `~/.claude.json` key `cachedUsageUtilization` (found by keyword sweep of
  `~/.claude*`; no other file carries window fields): `fetchedAtMs`,
  `accountUuid`, and `utilization` with `five_hour`/`seven_day` summaries
  plus a `limits[]` array — `kind` (`session`/`weekly_all`/
  `weekly_scoped`), `percent`, `severity`, `resets_at` (ISO 8601),
  `is_active`, and `scope.model.display_name` for the per-model weekly
  window. This is a superset of the `UX-DESIGN.md` §2 display contract.
  Sanitized capture: `tests/fixtures/cached-usage-utilization.json`.

  Freshness behavior observed: the cache lagged live values by 26 minutes
  during an active session; `-p "/usage"` runs rewrite it only when it is
  already stale by the CLI's own standard. Runs against a 26-min-old and an
  11-min-old cache both rewrote it (with live values, at zero cost); runs
  against a 1–3-min-old cache rendered fresh values but did not rewrite
  it. The CLI's internal write-throttle therefore sits between ~3 and ~11
  minutes. Hence the hybrid: the file cannot be assumed fresh, but a spawn
  makes it fresh whenever it is more than ~11 minutes old.

- [ ] **Q3** - What GNOME Shell version range does Claudometer target (affects
  available JS/`St`/`Clutter` APIs and extension.js module format)? Deferred
  to `designs/USER-TASKS.md` / a follow-up task rather than blocking this RFC.

## References

- `VISION.md` - G1 (zero token cost) is the constraint this RFC exists to
  satisfy.
- `designs/UX-DESIGN.md` §2 - the `UsageSnapshot` display contract the
  chosen source must fill; §3.3/§4.5/§6 - the degraded-state UI this RFC's
  failure taxonomy maps onto.
- `tests/fixtures/README.md` - provenance and sanitization of the committed
  evidence captures.
