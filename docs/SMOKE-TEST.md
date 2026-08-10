# Claudometer Multi-provider Smoke Test

The manual acceptance checklist for the MVP: `designs/USER-TASKS.md`
UT-001/002/003 end to end, the surrounding lifecycle behaviors, and the
`designs/UX-DESIGN.md` §8 accessibility bar. Run it before any release
(`docs/RELEASE.md`) and after any change to the Shell-coupled layer
(`src/extension.js`, `src/indicator.js`, `src/menu.js`, `src/gauge.js`).

Automated coverage lives below the smoke line: the pure models, parser,
scheduler, and source are unit-tested (`./scripts/quality.sh`); this
checklist covers only what needs a running GNOME Shell — real widgets,
focus, keyboard, theme, and lifecycle.

## Setup

Follow `docs/DEVELOPING.md`: symlink `src/` into the extensions directory,
start the throwaway headless Shell, and enable the extension over the
session's own D-Bus. All driving below uses `org.gnome.Shell.Eval`
(available because of `--unsafe-mode`); screenshots work headless via
`Shell.Screenshot`.

**Simulating data states.** `UsageSource` reads its config per fetch, so a
running extension can be pointed at prepared cache files without code
changes. From Eval:

```js
const ext = Main.extensionManager.lookup('claudometer@illyayalovyy.github.io').stateObj;
ext._claudeSource._config.filePath = '/tmp/claudometer-smoke/<state>.json';
ext._claudeSource._config.refreshArgv = ['/bin/true']; // or a fixture fake
// For deterministic Codex states, replace ext._codexSource._fetcher with an
// async function returning a prepared {fetchedAt, windows} or error snapshot.
ext._scheduler.refreshNow();
```

Prepare one cache file per state (shape: `{"cachedUsageUtilization": {...}}`
— see `tests/fixtures/cached-usage-utilization.json` for the inner shape):
fresh `fetchedAtMs` with percents below/at/above the thresholds, a 100%
window with a near `resets_at`, an old `fetchedAtMs` (stale), a file
without `cachedUsageUtilization` (signed-out), and a missing path
(not installed). `tests/fixtures/bin/` has the fake CLIs for refresh
behavior (`emit-file`, `exit-nonzero`, `record-refresh`).

Settings changes must go through Eval too (`GSETTINGS_BACKEND=memory` is
per-process): `new Gio.Settings({...})` inside the Shell, not the
`gsettings` CLI.

Record a result for every item: **PASS**, **FAIL** (file or fix, then
note), or **BLOCKED** (with why). Boundary items state the exact value
tested so reruns test the same edge.

## A. UT-001 — glance at usage from the panel

1. **Normal state, both provider constraints.** Feed Claude session 27%, week
   34%, and Codex windows 25%/42%. Expect: spark + blue vertical meter at 34%,
   then code-bracket mark + blue meter at 42%. No percentage labels.
2. **Warning threshold boundary.** Feed either provider constraint exactly 80%
   (default warning threshold). Expect its meter in warning color
   (`#f5c211`); 79% must stay blue. The other provider is unchanged.
3. **Critical threshold boundary.** Feed either provider constraint exactly
   95%. Expect its meter in error color (`#c01c28`); 94% stays warning.
4. **Limit hit.** Feed constraint 100% with a reset ~1 h out. Expect a full
   error-color meter; the dropdown and accessible name carry the reset time.
5. **Neutral symbols.** At 1× and 2× scale, verify the original eight-ray
   spark and generic `</>` mark are crisp and distinguishable, with no vendor
   logos or brand artwork.
6. **Independent unavailable state.** Make Codex unavailable with healthy
   Claude data, then reverse it. Expect only the unavailable provider pair to
   dim and show a slashed empty meter.

## B. UT-002 — usage detail on demand

7. **Menu layout.** Open the menu on full fixture data. Expect provider-prefixed
   Claude session/week/model sections, then general Codex and named model
   bucket sections; each has title, progress bar + percent, reset row, and
   separators. The footer reports both provider ages. At 1280×720, verify the
   menu scrolls just enough to reach the footer instead of extending off-stage.
   No settings gear.
8. **Independent bar coloring.** Feed session 97% + week 34%. Expect only
   the session bar in error color; the week bar stays foreground.
9. **Reset row formats.** A reset < 24 h away renders
   `Resets in N h M m (HH:MM)`; a reset > 24 h away renders date-only
   (`Resets Tue, Jul 28`).
10. **Freshness footer ticks.** With the menu open, watch the footer:
    `Updated just now` under 30 s, then `Updated 1 min ago` — it must
    advance while the menu stays open.
11. **Manual refresh.** Activate the refresh button. Expect: spinner
    replaces the icon during the fetch, menu stays open, footer returns
    to `Updated just now`, keyboard focus is not lost.
    - **Spinner honesty (#20).** With a slow refresh CLI (e.g.
      `refreshArgv = ['/bin/sh', '-c', 'sleep 3']`), click refresh, then
      change a display setting (e.g. `indicator-style`) while it spins:
      the spinner must keep spinning until the manual fetch lands, and
      only then hand back the icon. Likewise a background poll snapshot
      landing mid-request must not stop it early.
12. **Menu-open implicit refresh.** With a snapshot older than 15 s,
    opening the menu triggers a fetch (the footer updates when it lands);
    reopening within 15 s does not. The refresh button must **not** spin —
    the spinner is reserved for the explicit button refresh (#23). On a
    signed-out setup with the #19 give-up engaged, repeated menu opens
    spawn no `claude` processes (watch the journal / `pgrep`); the refresh
    button still spawns and re-arms.
13. **Dismiss.** Esc and clicking outside both close the menu; the panel
    returns to the ambient indicator; the displayed state is unchanged by
    an open/close cycle (no background state change).

## C. UT-003 — unavailable and degraded states

14. **Not installed.** Point the Claude file/argv at missing paths while Codex
    remains healthy. Expect only Claude's pair dimmed with a slashed empty
    meter; Codex remains filled. The menu keeps Codex rows and shows the
    Claude-specific not-found notice; refresh remains present.
15. **Signed out / unreadable.** Feed a well-formed file without
    `cachedUsageUtilization`. Expect: same indicator; menu shows "Can't
    read usage data." + "Open Claude Code and sign in, then refresh.",
    footer `Last tried N min ago` (never "Updated"), refresh button
    present. No raw error string anywhere in the menu.
16. **Recovery.** From either state above, restore a good file and hit
    refresh. Expect the normal rendering without disable/enable.
17. **Stale.** Feed an old `fetchedAtMs` (older than 3× the refresh
    interval) with a failing refresh CLI (`exit-nonzero`). Expect:
    Claude's pair dimmed to 55% but still showing the last vertical fill and
    threshold color; Codex stays fully opaque. The menu footer is warning:
    `Data is N min old — last refresh failed`.
18. **G1 tripwire.** Point `refreshArgv` at a fake CLI emitting an
    envelope with nonzero token usage. Expect: one journal warning about
    permanently disabling the refresh path, no further spawns (even
    manual), file reads keep working. This is the RFC-001 fail-closed
    check — it must never be skipped.

## D. Lifecycle and environment

19. **Enable → disable → re-enable.** Via D-Bus. Expect: indicator
    appears/disappears/reappears; zero `JS ERROR` lines mentioning the
    UUID in the Shell log; no fetch activity while disabled (fake CLI
    run-log stays flat).
20. **Unlock / resume refresh.** With the extension running, emit a
    screen-shield unlock (`Main.screenShield` `locked-changed` with
    `locked === false`). Expect an immediate out-of-cadence fetch (§6).
    For resume-without-lock, verify the login1 wake source is live
    (`stateObj._resumeAdapter._subscriptionIds.size === 1` via Eval);
    login1's `PrepareForSleep` cannot be spoofed on the system bus (the
    subscription matches the name's real owner), so the false-edge fetch
    itself needs a genuine suspend/resume when running on hardware.
21. **Live settings.** Change `warning-percent` so the current percent
    crosses states, and `refresh-interval-seconds`. Expect re-render and
    recadence with no disable/enable (UT: the indicator changes color in
    place).
22. **Light/dark theme.** Toggle `org.gnome.desktop.interface`
    `color-scheme` between `prefer-dark` and `default`. Expect the
    indicator and menu to stay legible; monochrome elements recolor with
    the theme automatically.
23. **Large text.** Set `text-scaling-factor` to 1.5. Expect the panel
    label to scale with the panel font (no hardcoded size) and the menu
    text to scale; layout does not clip.
24. **Clock format.** Set `org.gnome.desktop.interface` `clock-format` to
    `12h`. Expect reset times as `5:00 PM` style in menu rows and the
    accessible name; `24h` gives `17:00`.
25. **Preferences window.** Open prefs (Extensions app or
    `gnome-extensions prefs`). Expect one page with Thresholds and Refresh;
    threshold spins enforce warning < critical both ways. No obsolete
    indicator-style/headline controls.

## E. Accessibility (UX §8)

26. **Accessible name per state.** Read the indicator's `accessible-name`
    (Accerciser, or `Main.panel.statusArea[uuid].accessible_name` via
    Eval) in each state. Expect the full story, independent of display
    mode:
    - normal: both `Claude usage: …` and `Codex usage: …` clauses
    - stale: only the stale provider clause says `data is N min old`
    - unavailable: only that provider says `usage data unavailable`
27. **Keyboard-only operation.** Without a pointer: focus the indicator
    (Ctrl+Alt+Tab to the top bar in a real session, or `grab_key_focus()`
    headless), Enter/Space opens the menu, arrows walk the items, Enter
    on the footer row triggers refresh *without closing the menu*, Esc
    closes. The refresh button reads as `Refresh usage data`.
28. **Monochrome legibility.** Compare normal/warning/critical/limit-hit/
    stale/unavailable screenshots ignoring hue. Exact state remains available
    in menu text/accessibility; stale uses dimming and unavailable uses a
    slash, so neither relies on hue.

## Results

Record one row per item per execution; keep the latest execution here and
move older ones to the task/issue that ran them.

| Executed | Commit | Items | Result |
|---|---|---|---|
| 2026-08-09 | working tree (RFC-002 implementation) | RFC-002 items 1, 5, 7, 19, 26 | PASS in GNOME Shell 49.9 headless: two symbols/meters rendered from live Claude+Codex data, five provider-prefixed menu windows rendered general-before-model, 720px overflow scrolled to a reachable footer, keyboard focus auto-scrolled the footer into view, combined accessible name present, clean enable/disable. Full release smoke remains required. |
| 2026-07-26 | the commit carrying this table (task #14) | 1–28 | 25 PASS as written; 3 FAIL → fixed in the same commit and re-verified PASS (details below) |

Execution notes (GNOME Shell 49.8, headless throwaway session per Setup;
full driving transcript in issue #14's completion report):

- **1–18, 21–23, 25, 26, 28: PASS.** Highlights: 80/95 threshold
  boundaries exact (79→normal, 94→warning); limit-hit shows hourglass +
  `1 h 11 m` countdown, which overrides icon-only mode; the G1 tripwire
  (18) disabled the refresh path after one non-zero envelope, logged one
  journal warning, and kept serving file reads; 3× enable/disable cycles
  with zero `JS ERROR` lines; grayscale screenshots keep all six states
  distinguishable by shape/text alone.
- **19 (soak):** ~35 min of driven session across two Shell instances,
  ending in a ~4.5 min quiet soak at 30 s cadence against the real CLI:
  RSS flat (311→308 MB), FDs flat (83→77), zero journal errors.
- **20 FAIL → fixed.** No wake sources were wired
  (`Scheduler._wakeIds.length === 0`); emitting an unlock produced no
  fetch. Fixed in `src/extension.js` (screen-shield `locked-changed`
  gated on `!locked`); re-verified: unlock fetches, lock does not.
  Nuance: with no `unlock-dialog` session mode in `metadata.json`, a real
  lock also disables the extension and re-enable on unlock fetches
  anyway; the wake source implements the §6/#6 contract for any
  configuration where the extension stays enabled across a lock.
- **24 FAIL → fixed.** With `clock-format=12h` the reset row still
  rendered `(12:03)`. The extension never read the system clock format
  (models' `clock24` default always won). Fixed: `displayOptions` carries
  `clock24`, `extension.js` reads `org.gnome.desktop.interface
  clock-format` and re-renders on change. Re-verified: `(12:09 PM)` ↔
  `(12:09)` live.
- **27 partial FAIL → fixed.** Keyboard flow passed (Return opens, arrows
  walk, Enter on the footer refreshes without closing, Esc closes) but
  focused data rows exposed *no accessible name*. Fixed: every row sets
  `label_actor` to its text label; re-verified via the AT-SPI
  `LABELLED_BY` relation on all 13 rows.
- **Real-data check:** against the live `~/.claude.json` + real
  `claude -p /usage` refresh, the indicator rendered the true constraint
  (weekly per-model window) and tracked it across polls.
- **Known interaction (filed as a follow-up issue):** the CLI throttles
  cache rewrites (~5 min observed), while stale triggers at 3× the poll
  interval (90–180 s at the fast settings), so a working setup can render
  brief stale windows whose footer says "last refresh failed" — the age
  is honest but the explanation isn't. Needs a design decision (stale
  floor or wording), not a spot fix.
