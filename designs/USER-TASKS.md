# User Tasks

This file captures the user workflows the project must support. Treat it as a
test planning document, not marketing copy.

Each task should define:

- **Precondition** - what must be true before the user starts
- **Flow** - the sequence of user actions in the happy path
- **Outcome** - what the user observes when done
- **Interactions** - count of meaningful actions in the happy path
- **Regression coverage** - test name or reason coverage is manual

## UT-001: Glance at current Claude and Codex usage from the panel

**Precondition:** GNOME Shell is running with Claudometer enabled; at least
one of Claude Code or Codex is installed and authenticated on the machine.

**Flow:**

1. User looks at the GNOME top panel.

**Outcome:** The indicator shows one neutral provider symbol and vertical
constraint meter for Claude and Codex. Available providers show current used
quota; unavailable providers are explicitly slashed without hiding the other.
The extension has not sent anything to a model to produce either reading.

**Interactions:** 0 (ambient - no click required for the headline number).

**Regression coverage:**
`derive.test.js` and `indicator_model.test.js` (per-provider constraint and
compact-item derivation), plus the original Claude constraint coverage:
`the_highest_percent_wins_across_all_window_groups`,
`classifies_every_threshold_boundary_at_the_defaults`),
`indicator_model.test.js` (`every_3_3_table_row_renders_in_the_default_mode`
and the display-mode/accessible-name suite), and
`degraded_pipeline.test.js` (the displayed value tracks the real
fetcher → source → scheduler → render-model pipeline). The G1 half — the
fetch never invokes the model — is
`fetcher.test.js::any_sign_of_model_involvement_trips_the_g1_tripwire`,
`source.test.js::model_invoked_permanently_disables_the_refresh_path`, and
the `scripts/quality.d/50-fixtures` envelope invariants on every gate run.
Live-Shell rendering: `docs/SMOKE-TEST.md` items 1–6.

## UT-002: See Claude and Codex usage detail on demand

**Precondition:** Same as UT-001.

**Flow:**

1. User clicks the panel indicator.
2. The dropdown opens showing provider-prefixed Claude and Codex windows,
   percentages, and reset times (including model-specific buckets).
3. User clicks elsewhere to dismiss.

**Outcome:** Detail and independent provider freshness are visible while open;
the panel returns to the ambient indicator on dismiss. Opening does not change
provider state except for the documented implicit metadata refresh.

**Interactions:** 2 (open, dismiss).

**Regression coverage:**
`menu_model.test.js` (`all_windows_present_renders_the_4_1_mockup_in_order`,
`each_bar_colors_by_its_own_windows_thresholds`,
`footer_freshness_covers_just_now_minutes_and_stale`,
`reset_rows_honor_the_12_hour_clock_option`) and `scheduler.test.js`
(menu-open/manual refresh policy). Open/dismiss, keyboard navigation,
focus, and the no-background-state-change rule need a running Shell:
`docs/SMOKE-TEST.md` items 7–13 and 27.

## UT-003: Understand when either provider is unavailable

**Precondition:** Claude Code or Codex is not installed, not authenticated, or
its usage data cannot be read.

**Flow:**

1. User looks at the GNOME top panel.

**Outcome:** That provider's meter shows a clear unavailable state rather than
a stale, blank, or misleading number; a healthy other provider stays visible.

**Interactions:** 0.

**Regression coverage:**
`tests/unit/degraded_pipeline.test.js::ut_003_walkthrough_not_installed_recover_limit_hit_go_stale`
(the real fetcher → source → scheduler → render-model pipeline over fake
CLI binaries), plus per-state unit tests:
`indicator_model.test.js` (unavailable/stale/limit-hit indicator states),
`menu_model.test.js::not_installed_renders_the_4_5_not_found_notice`,
`::unreadable_or_signed_out_renders_cant_read_with_last_tried`,
`::raw_error_strings_never_surface_in_the_menu_model`, and
`source.test.js` (failure taxonomy of the composed RFC-001 data source).
