# Claudometer — UX Design

Status: Implemented (RFC-001 ratified Implemented 2026-07-26; verified
against this design by the MVP smoke pass, `docs/SMOKE-TEST.md`)

This document defines the user-facing design of the Claudometer GNOME Shell
extension: what appears in the panel, what appears in the dropdown, every
visual state, and the interaction and accessibility rules. It deliberately
does not decide *where the data comes from* — that is
`RFC-001-usage-data-source.md`. Instead it defines a **display contract**:
which fields the UI wants, and how the UI degrades when a field is missing.

**Scope (ratified 2026-07-24): subscription plans only.** The design is
built around subscription rate-limit windows (percent used, reset time).
API-key metering (pay-per-token, no windows) is a different product and is
out of scope — see VISION and RFC-001 NG2. An API-key-only setup renders as
the *unavailable* state, not as a degraded percentage view.

## 1. Design goals

1. **One-glance answer to one question:** "how close am I to being cut
   off?" Everything else is secondary detail behind a click.
2. **Honest by construction.** Never show a number the data source did not
   provide. Missing data renders as an explicit unavailable/stale state, not
   as `0%`, not as a frozen last value silently presented as current.
3. **Native, quiet, HIG-compliant.** The indicator should be visually
   indistinguishable in weight from GNOME's own system indicators (battery,
   network). No branding colors, no logo lockups, no attention-seeking
   animation.
4. **State never encoded by color alone.** Every color change is paired with
   an icon-shape or text change (color-blind users, monochrome themes).

## 2. The data model the UI consumes

The UI consumes a `UsageSnapshot` with this shape (fields optional unless
marked required):

| Field | Required | Meaning |
|---|---|---|
| `fetchedAt` | yes | Wall-clock time the snapshot was obtained |
| `session.percent` | no | % of 5-hour rolling window used |
| `session.resetsAt` | no | When the session window resets |
| `week.percent` | no | % of weekly (all-models) limit used |
| `week.resetsAt` | no | When the weekly window resets |
| `weekModel[]` | no | Per-model weekly entries (e.g. Opus), same shape |
| `error` | no | Machine-readable reason the source failed |

Derived value used everywhere: **`constraint` = the window with the highest
`percent`** — the limit the user will hit first. This is the headline number.
If only one window is present, it is the constraint. If none are present,
the snapshot is *unavailable*.

Rationale: users do not want to arbitrate between windows at a glance. The
battery indicator does not show per-cell voltages; it shows the number that
determines when you stop working.

## 3. Panel indicator

### 3.1 Anatomy

```
┌─────────────────────────────┐
│  ◔ 67%                      │   icon (16px symbolic) + optional label
└─────────────────────────────┘
```

- **Icon:** a custom symbolic icon (`claudometer-symbolic.svg`), drawn as a
  simple circular meter/gauge that fills clockwise with usage — quarter
  filled at 25%, three-quarters at 75%. Monochrome, inherits panel
  foreground color, follows the `-symbolic` naming and recoloring rules.
  Deliberately *not* an Anthropic/Claude logo: trademark risk, and logos
  read as launchers, not meters.
- **Label:** the constraint percentage, e.g. `67%`. Follows the panel font;
  never bold, never colored independently of the icon.
- **Display modes** (preference, see §7): icon+percent (default),
  icon-only, percent-only. Icon-only exists because horizontal panel space
  is contested; percent-only exists for users who find duplicate encoding
  redundant.

### 3.2 Placement

Right panel box, grouped with the status/system indicators, default index
adjacent to them (before the quick-settings aggregate). This is where users
look for "how much is left of X" information (battery precedent). Position
is not user-configurable in v1 — every configurable placement option is a
support burden, and extensions that must move can be reordered by dedicated
extensions the user may already have.

### 3.3 Indicator states

| State | Trigger | Icon | Label | Color |
|---|---|---|---|---|
| Normal | constraint < 80% | meter, filled to % | `67%` | theme foreground |
| Warning | 80% ≤ constraint < 95% | meter + small `!` overlay | `84%` | theme warning (fallback `#f5c211`) |
| Critical | constraint ≥ 95% | meter + `!` overlay | `97%` | theme error (fallback `#c01c28`) |
| Limit hit | constraint ≥ 100% | hourglass glyph | time to reset, `1h 12m` | theme error |
| Stale | data older than 3× poll interval | current meter at 55% opacity | last % at 55% opacity | inherited |
| Unavailable | no usable data | meter outline with a slash | *(none)* | 55% opacity foreground |

Notes:

- Warning/critical thresholds are preferences (defaults 80/95). The `!`
  overlay — not just color — is what distinguishes warning from normal.
- **Limit hit swaps the label's meaning from "how much used" to "when am I
  back."** Once at 100%, the percentage is dead information; the only thing
  the user wants is the countdown. The hourglass glyph signals the semantic
  change so `1h 12m` is not misread as a percentage.
- Stale keeps showing the last value (dimmed) rather than hiding it: an
  hour-old 40% is still more useful than nothing, as long as it is visibly
  not-fresh. The menu states the exact age (§4.4).
- Unavailable shows no number at all. Showing `0%` here would be the single
  worst honesty failure this design can commit.
- No animation in any state. No pulsing at critical. The panel is ambient;
  a user at 97% who has not clicked does not want to be nagged, and GNOME
  HIG reserves attention-demanding motion for notifications.

## 4. Dropdown menu

Opened by primary click or keyboard activation. Standard `PopupMenu`
machinery — inherits shell theme, keyboard navigation, and dismissal
behavior for free.

### 4.1 Layout (all data present)

```
┌──────────────────────────────────────────┐
│  Session (5-hour window)                 │
│  ████████████████░░░░░░░░  67%           │
│  Resets in 2 h 15 m  (17:00)             │
│  ──────────────────────────────────────  │
│  Week — all models                       │
│  ██████████░░░░░░░░░░░░░░  42%           │
│  Resets Tue, Jul 28                      │
│  ──────────────────────────────────────  │
│  Week — Opus                             │
│  ████░░░░░░░░░░░░░░░░░░░░  18%           │
│  Resets Tue, Jul 28                      │
│  ──────────────────────────────────────  │
│  Updated 2 min ago              ⟳        │
└──────────────────────────────────────────┘
```

Each window is a section: **title row, progress bar with percentage,
reset row.** Sections appear only if their data exists in the snapshot —
no empty placeholders for windows the user's plan doesn't have.

### 4.2 Progress bars

- Custom-drawn `St` widget, full menu width, ~6px tall, rounded.
- Track: theme's insensitive/dim foreground at low opacity. Fill: theme
  foreground normally; theme warning/error color when *that window* crosses
  the thresholds. (Each bar colors independently — the weekly bar isn't
  painted red because the session bar is.)
- The numeric percentage always accompanies the bar. The bar is texture;
  the number is the datum.

### 4.3 Reset rows

- Relative + absolute together: `Resets in 2 h 15 m (17:00)`. Relative
  alone goes stale while the menu is open; absolute alone forces mental
  arithmetic. Under ~1 minute: `Resets in <1 min`.
- Weekly resets beyond 24h drop the relative form: `Resets Tue, Jul 28`
  (a "resets in 4 days 7 h" countdown is noise at that distance).
- Times honor the system 12/24-hour clock format setting.

### 4.4 Footer row

- Left: freshness — `Updated 2 min ago`, or `Updated just now` under 30s.
  In the stale state this line carries the warning color and the icon's
  dimming is explained by the honest age: `Data is 25 min old`. The
  `— last refresh failed` clause is appended only when the last refresh
  spawn actually failed (#16): the CLI throttles rewrites of its cache,
  so old data on a healthy setup must not be blamed on a failure that
  didn't happen.
- Right: a refresh button (`view-refresh-symbolic`). Manual refresh is the
  escape hatch for "I just ended a big session, what did it cost me?" The
  button shows a brief spinner during fetch; on failure the freshness line
  updates with the error state rather than a toast (no notification spam).
- No settings gear in the menu footer for v1: preferences are reachable via
  the Extensions app, which is the GNOME-native path. (Revisit if users
  demonstrably fail to find prefs.)

### 4.5 Menu in degraded states

**Unavailable — Claude Code not found:**

```
│  Claude Code was not found on this      │
│  system.                                │
│  Claudometer reads usage from a local   │
│  Claude Code installation.              │
```

**Unavailable — data unreadable / not authenticated:**

```
│  Can't read usage data.                 │
│  Open Claude Code and sign in, then     │
│  refresh.                               │
│  ──────────────────────────────────    │
│  Last tried 1 min ago            ⟳     │
```

Rules: plain-language sentence first, cause second, action third. Never a
raw error string or exit code in the menu (those go to the journal/log).
The refresh button remains available in every degraded state — it is the
user's "I fixed it, check again."

**Limit hit:** sections render as usual (the bar full, at error color);
the constraint section's reset row is promoted to the top of the menu as
the first line: `Session limit reached — resets in 1 h 12 m (17:00)`.

## 5. Interaction summary

| Input | Action |
|---|---|
| Primary click / Space / Enter | Toggle dropdown |
| Menu keyboard navigation | Standard PopupMenu (arrows, Esc) |
| Scroll wheel over indicator | Nothing (deliberate — accidental scrolls must not trigger fetches or mode changes) |
| Middle click | Nothing in v1 (invisible affordances need a discoverability story first) |

Opening the menu triggers an implicit refresh if the snapshot is older than
15 seconds, so the detail view is near-live without aggressive background
polling. This implicit refresh is not a manual refresh (#23): the fetch
reaches the data source unflagged, so the source's own freshness and
give-up gates decide whether the CLI is spawned, the §6 failure backoff is
not reset, and the §4.4 refresh spinner does not run for it. Only the §4.4
refresh button carries explicit refresh intent.

## 6. Refresh policy (UX-visible aspects)

- Default background poll: every 60 s (preference: 30 s–10 min). The
  freshness footer makes the cadence legible to the user.
- On unavailable/error: exponential backoff (1 → 2 → 5 min cap) so a
  missing installation doesn't burn cycles; any manual refresh resets the
  backoff.
- On session unlock / resume from suspend: immediate refresh (the user has
  been away; the first glance after unlock should not be stale).
- A refresh **never** blocks the shell UI; the indicator keeps its previous
  state until the new snapshot lands.

## 7. Preferences (GTK4/libadwaita window)

One page, three groups. Every preference must earn its place; defaults are
chosen so most users never open this window.

**Display**
- Indicator style: Icon and percentage (default) / Icon only / Percentage only
- Headline metric: Most constrained (default) / Session window / Weekly

**Thresholds**
- Warning at: 80% (spin, 50–95)
- Critical at: 95% (spin, warning+1–100)

**Refresh**
- Interval: 1 min (default; 30 s / 1 min / 2 min / 5 min / 10 min)

"Headline metric" exists for the user who is on an effectively unlimited
weekly plan and only cares about the session window (or vice versa); pinning
prevents the headline from flapping between windows near-equal in usage.

## 8. Accessibility

- Indicator `accessible-name` carries the full story the icon tells:
  "Claude usage: 67 percent of session limit used, resets at 5:00 PM" —
  updated on every snapshot, including state qualifiers ("data is 25
  minutes old", "usage data unavailable").
- Menu rows are real menu items with proper labels; progress bars expose
  their value via the accompanying text, not as unlabeled drawings.
- All colors come from the shell theme with sufficient-contrast fallbacks;
  the design is fully legible in pure monochrome (state = shape + text).
- Honors large-text/text-scaling settings; the label uses the panel's font
  size, never a hardcoded one.

## 9. Anti-goals (things this design refuses to do)

- **No notifications in v1.** A "you're at 90%" notification is plausible
  future work, but it changes the product from ambient meter to interrupter
  and needs its own design pass (quiet hours, dedupe, threshold hysteresis).
- **No cost-in-dollars display.** Subscription windows are percentages;
  inventing a dollar figure implies precision the data doesn't have.
- **No historical charts in the dropdown.** A panel menu is a glance
  surface; anything worth a chart is worth a real window, which is out of
  scope (VISION: not a dashboard).
- **No logo-as-icon, no brand colors.** See §3.1 and VISION §"native".

## 10. Open UX questions

- [x] **UX-Q1** — ~~What does the real `/usage` data actually expose for
  API-key (non-subscription) users?~~ **Resolved 2026-07-24 by user
  decision: API-key users are out of scope entirely** — subscription plans
  only. No token-count variant of the design is needed; an API-key-only
  setup gets the unavailable state (see Scope note at top).
- [ ] **UX-Q2** — Per-model weekly rows: is showing more than two total
  sections ever necessary? If plans grow more windows, the menu may need a
  "show all" disclosure rather than unbounded stacking.
- [x] **UX-Q3** — Should the "limit hit" countdown appear in the panel even
  in icon-only mode (temporarily overriding the mode)? **Resolved
  2026-07-26: yes, implemented as the lean suggested** —
  `src/lib/indicator_model.js` overrides icon-only with the countdown when
  a reset time exists (and falls back to the honest 100% label when it
  doesn't). Verified in the MVP smoke pass (docs/SMOKE-TEST.md item 5).

## 11. Traceability

| User task | Sections |
|---|---|
| UT-001 (glance) | §3 indicator, §2 constraint derivation |
| UT-002 (detail on demand) | §4 dropdown, §5 interaction |
| UT-003 (unavailable state) | §3.3, §4.5 |
