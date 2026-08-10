# RFC-002: Multi-provider usage and compact panel meters

| Field | Value |
|---|---|
| Status | Implemented |
| Author(s) | Illya Yalovyy, Codex implementation agent |
| Supersedes | `UX-DESIGN.md` §3.1 panel anatomy and §7 indicator-style/headline controls |
| Superseded by | - |

## Summary

Extend Claudometer from one Claude Code usage source to independent Claude Code
and Codex providers, and replace the single circular headline gauge with one
compact symbol-and-vertical-meter pair per provider. Claude keeps its existing
local-cache/zero-model refresh path. Codex usage is read through the documented
Codex App Server `account/rateLimits/read` method, which exposes quota usage,
window duration, and reset time without starting a model turn.

## Goals

- **G1** - Show the most constrained current Claude and Codex quota side by
  side in the GNOME panel.
- **G2** - Show every available Claude and Codex limit and reset time in the
  dropdown, including model-specific Codex buckets.
- **G3** - Keep quota checks model-free, read-only, credential-free in the
  extension, and honest when either provider is unavailable or stale.
- **G4** - Use generic, original geometric symbols rather than vendor logos or
  other copyrighted/trademarked artwork.

## Non-Goals

- **NG1** - API token billing, spend accounting, credit purchase, or consuming
  earned rate-limit resets.
- **NG2** - Starting Codex/Claude turns, changing authentication, or retaining
  credentials returned by either CLI.
- **NG3** - A user-configurable icon/logo system. The compact representation is
  deliberately consistent so the two providers remain comparable.

## Background and Motivation

The implemented MVP has one top-level `UsageSnapshot`, one derived constraint,
and one circular gauge. That cannot represent independent Claude and Codex
availability or show both providers at a glance. The requested reference uses
repeated compact units: a recognizable neutral symbol followed by a narrow
vertical fill meter.

Official OpenAI documentation defines Codex App Server as the integration
surface used by rich Codex clients. Its newline-delimited JSON protocol exposes
`account/rateLimits/read`. Each returned bucket has a stable `limitId`, optional
display `limitName`, `primary`/`secondary` quota windows, `usedPercent`,
`windowDurationMins`, and a Unix-seconds `resetsAt` value.

A local probe on 2026-08-09 with `codex-cli 0.147.0` confirmed that the
documented request returns the backward-compatible `rateLimits` bucket and the
multi-bucket `rateLimitsByLimitId` view. The latter included both a general
Codex bucket and a model-specific bucket. No thread or turn was created.

## User Impact

| Audience | Impact |
|---|---|
| End users | See Claude and Codex constraints side by side; clicking reveals all available windows and provider-specific failures. |
| Contributors | Add provider adapters behind one combined snapshot; UI models consume provider windows rather than assuming one vendor. |
| Operators / packagers | Codex data requires a locally installed, ChatGPT-authenticated Codex CLI. No new packaged dependency is added. |

## Considered Options

### Option A - Parse local Codex rollout/session files

**Pros**: Local reads only; no subprocess or network activity.

**Cons**: Rate-limit events are an undocumented internal shape, are written only
after Codex activity, can be absent or stale, and would require reading files
that also contain conversation data. It is a poor privacy and drift boundary.

### Option B - Use the documented Codex App Server account method

**Pros**: Documented machine-readable protocol; returns live, explicit quota
windows; reuses Codex authentication without exposing it to the extension; no
model turn or prompt is created; supports multiple metered/model buckets.

**Cons**: Starts a short-lived Codex subprocess and lets the user's Codex client
perform a metadata request. The adapter needs timeout, process-reaping, and
strict schema handling.

### Option C - Call a ChatGPT web endpoint directly

**Pros**: Could avoid a subprocess.

**Cons**: Would make the extension own an undocumented network/auth protocol and
credentials, conflict with the project's read-only/no-account boundary, and be
more fragile than the supported client interface.

## Decision

**Chosen option: Option B.** It is the only documented, machine-readable quota
surface that preserves the existing trust boundary: the installed provider
client owns authentication and metadata network access, while the extension
only sends an account read request and parses the returned limits.

Claude and Codex remain independent provider snapshots. Failure of one never
hides or slows the other. The combined source performs both reads concurrently,
and the existing scheduler continues to serialize refresh cycles.

## Design

### Provider snapshot contract

The scheduler receives:

```js
{
    providers: {
        claude: {fetchedAt, session?, week?, weekModel?, error?},
        codex: {
            fetchedAt,
            windows: [{
                limitId, limitName?, slot, percent,
                durationMins, resetsAt,
            }],
            error?,
        },
    },
}
```

The Claude value is the existing RFC-001 snapshot unchanged. The Codex parser
prefers `rateLimitsByLimitId` when present and falls back to `rateLimits`, so the
backward-compatible bucket is never displayed twice. Consumed fields are
strictly typed; percentages are clamped to 0–100, and unknown extra fields are
ignored. App Server error text is journal-only and never reaches the menu.

The Codex adapter caches its last successful result. A transient failure keeps
that snapshot with its original `fetchedAt`, allowing the normal stale UI to
remain honest. With no successful result, it returns an explicit provider error.

### Process and protocol lifecycle

For each due Codex read:

1. Resolve `codex` using the same GNOME-session PATH plus common user-bin
   fallback used for Claude.
2. Spawn `codex app-server` with stdin/stdout pipes and stderr suppressed from
   the UI surface.
3. Send `initialize`, `initialized`, then `account/rateLimits/read`.
4. Ignore notifications and unrelated responses; accept only the matching
   request id.
5. Close/terminate and asynchronously reap the subprocess after the response,
   EOF, or a 15-second timeout.

No `thread/start`, `turn/start`, login, logout, mutation, credit, or reset method
is sent.

### Panel representation

The panel renders one 16 px generic symbol plus one 6×18 px vertical meter per
available provider, matching the density and rhythm of the supplied reference.

- Claude: an original eight-ray spark, a generic assistant/insight metaphor.
- Codex: original angle-bracket strokes, a generic source-code metaphor.
- Meter: low-opacity outline/track with used quota filled from bottom. Normal
  uses the Shell accent color; warning and critical use theme warning/error
  colors. Stale/unavailable states are also encoded by opacity and a slash, so
  color is never the sole signal.

The fill always represents the provider's highest used percentage. The old
single-indicator style and headline pin settings remain in the schema for safe
upgrade compatibility but are no longer presented or used by the multi-provider
panel.

### Dropdown and failure behavior

The existing bar-row layout remains. Section titles gain a provider prefix.
Codex titles include the App Server's optional `limitName` and a normalized
window-duration label. Provider notices are independent: if Codex is missing,
Claude rows still render and the menu explains only the Codex problem. The
footer summarizes freshness for both providers and its refresh button updates
both.

## Testing Strategy

| Risk / invariant | Test layer | Location |
|---|---|---|
| App Server protocol/schema drift fabricates quota | Unit | `codex_snapshot.test.js`, strict mutations and multi-bucket fallback |
| Codex subprocess hangs, exits, or is absent | Unit/integration | `codex_fetcher.test.js` fake executables, timeout, reaping, taxonomy |
| One provider failure hides the other | Unit | `multi_source.test.js`, composite indicator/menu model tests |
| Panel no longer shows both compact meters | Pure model + manual Shell | `indicator_model.test.js`; RFC-002 smoke-test additions |
| Model-specific Codex limits disappear or duplicate | Unit | `codex_snapshot.test.js`, `menu_model.test.js` |
| Checking usage starts a model turn | Protocol invariant + manual | Assert request transcript contains account-read methods only; inspect live App Server response without thread/turn creation |

The exact Cairo rendering, theme colors, HiDPI size, focus behavior, and visual
match to the supplied screenshot require a running GNOME Shell smoke check.

## Goals Alignment

| Goal | How addressed |
|---|---|
| G1 | Per-provider constraint derivation feeds two fixed compact panel items. |
| G2 | Claude windows plus every Codex bucket/window are flattened into dropdown sections. |
| G3 | Provider-owned read-only metadata interfaces, strict parsers, cached stale fallback, independent errors. |
| G4 | Both marks are small Cairo primitives designed for this extension; no vendor artwork is shipped. |

## Development Plan

- [x] **Step 1** - Confirm the official Codex quota contract and probe the
  installed CLI. *(prerequisite: -)*
- [x] **Step 2** - Review and accept the provider/data/UI boundaries in this
  RFC. *(prerequisite: Step 1)*
- [x] **Step 3** - Implement and test the Codex parser/fetcher and combined
  source. *(prerequisite: Step 2)*
- [x] **Step 4** - Implement and test the compact panel and combined dropdown.
  *(prerequisite: Step 3)*
- [x] **Step 5** - Update user documentation and run the complete quality gate.
  *(prerequisite: Step 4)*

## Design Review

Reviewed against `docs/DESIGN-REVIEW.md` on 2026-08-09. The decision keeps
provider auth and networking outside the extension, adds no package dependency,
strictly contains protocol drift, permits provider-by-provider degradation, and
can be rolled back by removing the Codex adapter and restoring the existing
indicator widget. The implementation steps are independently reviewable and
the highest-risk process/protocol behavior has a fake-driven test seam.

## Open Questions

- [x] **Q1** - Does the supported Codex integration expose usage windows
  without a turn? **Yes.** `account/rateLimits/read` is an account method and
  the live probe returned limits without starting a thread or turn.
- [x] **Q2** - How are model-specific quotas represented? **As separate
  `rateLimitsByLimitId` buckets with optional `limitName` values.**
- [x] **Q3** - Should fill mean remaining or used? **Used**, matching the
  existing extension's percentages, thresholds, dropdown bars, and accessible
  wording.

## References

- [Official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server)
- [RFC-001: Claude usage data source](./RFC-001-usage-data-source.md)
- [UX design](./UX-DESIGN.md)
