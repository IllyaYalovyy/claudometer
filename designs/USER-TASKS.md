# User Tasks

This file captures the user workflows the project must support. Treat it as a
test planning document, not marketing copy.

Each task should define:

- **Precondition** - what must be true before the user starts
- **Flow** - the sequence of user actions in the happy path
- **Outcome** - what the user observes when done
- **Interactions** - count of meaningful actions in the happy path
- **Regression coverage** - test name or reason coverage is manual

## UT-001: Glance at current Claude usage from the panel

**Precondition:** GNOME Shell is running with Claudometer enabled; Claude
Code is installed and authenticated on the same machine.

**Flow:**

1. User looks at the GNOME top panel.

**Outcome:** The indicator shows a current usage figure (e.g. percentage of
the active rolling window) without the user taking any action, and without
the extension having sent anything to the model to produce it.

**Interactions:** 0 (ambient - no click required for the headline number).

**Regression coverage:** TBD once `designs/RFC-001-usage-data-source.md` is
accepted and the indicator exists - should assert the displayed value tracks
the underlying data source and that fetching it never invokes the model
(see RFC-001 G1).

## UT-002: See usage detail on demand

**Precondition:** Same as UT-001.

**Flow:**

1. User clicks the panel indicator.
2. The dropdown opens showing session tokens, rolling-window usage, and reset
   time(s).
3. User clicks elsewhere to dismiss.

**Outcome:** Detail is visible while open and the panel returns to the
ambient indicator on dismiss; no background state changes as a result of
opening it.

**Interactions:** 2 (open, dismiss).

**Regression coverage:** TBD - UI test once the dropdown exists.

## UT-003: Understand when data is unavailable

**Precondition:** Claude Code is not installed, not authenticated, or its
local usage data cannot be read.

**Flow:**

1. User looks at the GNOME top panel.

**Outcome:** The indicator shows a clear "unavailable" state rather than a
stale, blank, or misleading number.

**Interactions:** 0.

**Regression coverage:** TBD - unit test for the unavailable-state branch of
whichever data source RFC-001 selects.
