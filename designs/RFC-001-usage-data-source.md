# RFC-001: Usage Data Source

| Field | Value |
|---|---|
| Status | Draft |
| Author(s) | Illya Yalovyy |
| Supersedes | - |
| Superseded by | - |

## Summary

Claudometer needs to read Claude Code's token/usage state from GNOME Shell
without ever spending a token or model call to do so. This RFC picks where
that data comes from and how it is fetched.

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
- **NG2** - Supporting usage reporting for API-key-only setups that never run
  the `claude` CLI locally (revisit only if a real user asks).

## Background and Motivation

The CLI's interactive `/usage` slash command prints current plan usage
(session tokens, rolling 5-hour and weekly windows, reset times). The
original idea in the project brief was to shell out to:

```bash
claude -p "/usage" --output-format json
```

Two local sources of Claude Code usage state were found during setup
research, on this machine (GNOME Shell 49.8, `claude` on `PATH`):

1. **`claude -p "/usage" --output-format json` (or similar CLI invocation).**
   Slash commands like `/usage`, `/cost`, and `/status` are handled by the
   CLI itself and are not sent to the model as a prompt — but running them
   via `-p` still means spawning a full `claude` process per poll (higher
   latency, ~1-2s, and a dependency on the CLI's non-interactive slash
   command behavior being stable across versions). This needs to be verified
   directly against the installed CLI version before being relied on: **Open
   Question Q1**.
2. **`~/.claude/stats-cache.json`.** A local cache file already maintained by
   Claude Code containing `dailyModelTokens`, `modelUsage`, `totalSessions`,
   `dailyActivity`, and similar fields. Reading it is a plain file read: no
   subprocess, no CLI dependency, trivially zero-cost. It appears to hold
   historical/session token accounting, not necessarily the live rolling
   5-hour/weekly plan-limit windows or reset times that `/usage` shows
   interactively — that needs confirmation: **Open Question Q2**.

Neither source's exact shape is contractually documented; both are internal
Claude Code implementation details that could change between CLI versions.

## User Impact

| Audience | Impact |
|---|---|
| End users | See accurate, near-real-time usage with no token cost, or a clear "unavailable" state if Claude Code's local state can't be read. |
| Contributors | The data source is the one dependency most likely to break on a Claude Code update; it needs a documented fallback/detection strategy. |
| Operators / packagers | No network permissions or credentials needed beyond local filesystem/process access. |

## Considered Options

### Option A - Shell out to `claude -p "/usage" --output-format json`

**Pros**: Matches what a human would see running `/usage` interactively;
CLI owns the parsing of whatever backend state it uses, including live
rolling-window/reset data.

**Cons**: Process-per-poll cost (fork/exec latency); depends on
`--output-format json` and non-interactive slash-command behavior being
stable and documented; must be verified to truly avoid a model call in `-p`
mode, not assumed (Q1); requires the `claude` binary to be resolvable and
authenticated in the extension's execution environment (GNOME Shell's own
process, not a user shell).

### Option B - Read `~/.claude/stats-cache.json` (and related local files) directly

**Pros**: Zero subprocess cost, zero CLI-version coupling to a subprocess
contract, trivially fast to poll on any interval.

**Cons**: Undocumented/internal file format, no guaranteed stability across
Claude Code releases; may not carry the live rolling-window plan-limit data
the user actually wants glanceable (Q2); reading arbitrary Claude Code
internal state files is more fragile to silent schema drift than a CLI
contract.

### Option C - Hybrid: poll local files for cheap/frequent updates, fall back to (or periodically reconcile with) the CLI for the rolling-window/reset data the files may not carry

**Pros**: Cheap common case; still gets authoritative rolling-window data if
Option A turns out to be the only source for it.

**Cons**: Two data paths to maintain and keep consistent; more surface area
for bugs; only worth the complexity if Q2 confirms the files are
insufficient alone.

## Decision

**Not yet decided.** Resolving Q1 and Q2 first is a prerequisite — the right
option depends on their answers, not on preference. This RFC should return to
`Review` once both are answered with cited evidence (exact commands run,
exact output observed, CLI version).

## Design

To be filled in once an option is chosen. At minimum this section must cover:
polling interval and how it is chosen, failure/unavailable-state behavior
(Claude Code not installed, not authenticated, file/command missing or
unparseable), and how a future Claude Code CLI/format change is detected
rather than silently misread.

## Testing Strategy

| Risk / invariant | Test layer | Test name / location |
|---|---|---|
| Extension never triggers a model call to read usage | Manual / documented verification (see Q1) | TBD |
| Unavailable/unparseable data source degrades to a clear UI state, not a crash or silent wrong number | Unit | TBD |
| Polling does not leak processes/file handles over long uptime | Manual / soak | TBD |

What cannot be tested automatically: actual Claude API token accounting
correctness — that is Anthropic's backend, not this extension's code; the
extension can only be tested against the local values it reads.

## Goals Alignment

| Goal | How addressed |
|---|---|
| G1 | Decision is blocked on proving zero token spend for whichever option is chosen (Q1 for Option A; Option B is zero-spend by construction). |
| G2 | Both options are evaluated against a polling interval, not a live push mechanism, which is sufficient for an ambient indicator. |
| G3 | Both options reuse Claude Code's own local auth/session state rather than asking the user for credentials. |

## Development Plan

- [ ] **Step 1** - Answer Q1: confirm, on the actual target CLI version(s),
  whether `claude -p "/usage" --output-format json` (or an equivalent
  non-interactive invocation) reaches the model or is handled entirely
  locally. Cite the exact command and evidence (e.g. absence of API request
  in a network trace, or documentation). *(prerequisite: -)*
- [ ] **Step 2** - Answer Q2: determine whether local files under
  `~/.claude/` (starting with `stats-cache.json`) contain the rolling
  5-hour/weekly window and reset-time data, or only historical/session
  token counts. *(prerequisite: -)*
- [ ] **Step 3** - Choose an option based on Step 1/2 results and fill in
  Design, then move Status to `Review`. *(prerequisite: Step 1, Step 2)*
- [ ] **Step 4** - Implement the chosen data source behind a small interface
  so the option can be swapped without touching UI code. *(prerequisite: Step 3, Accepted)*

## Open Questions

- [ ] **Q1** - Does `claude -p "/usage" --output-format json` (or the best
  available non-interactive invocation) ever result in a billed model call,
  on the CLI version(s) this extension targets?
- [ ] **Q2** - Do local Claude Code files carry live rolling-window
  plan-limit and reset-time data, or only historical token/session counts?
- [ ] **Q3** - What GNOME Shell version range does Claudometer target (affects
  available JS/`St`/`Clutter` APIs and extension.js module format)? Deferred
  to `designs/USER-TASKS.md` / a follow-up task rather than blocking this RFC.

## References

- `VISION.md` - G1 (zero token cost) is the constraint this RFC exists to
  satisfy.
