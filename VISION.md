# Claudometer — Vision

## The Problem

Claude Code usage is metered in ways that are easy to lose track of:
session token counts, rolling 5-hour limits, and weekly limits, depending on
plan. Today, checking any of this means switching into a terminal, running
`claude`, and typing `/usage`. There is no ambient, always-visible way to see
it while working in other windows.

## The Solution

Claudometer is a GNOME Shell extension that surfaces Claude Code usage in the
top panel: a compact indicator, with a dropdown for more detail (session
tokens, rolling-window usage, plan limits, reset times).

**Core principles:**

1. **Zero token cost, by construction.** The extension must never consume
   Claude API tokens or model output to report on Claude API tokens. Every
   data source it uses must be a local read or a metadata-only query — never
   a prompt sent to the model. This is the one constraint the whole design
   answers to; see `designs/RFC-001-usage-data-source.md` for how usage data
   is actually obtained and why.
2. **Ambient, not intrusive.** A glance at the panel is enough. No polling
   loop should be aggressive enough to matter for battery or CPU; no popup
   should interrupt work uninvited.
3. **Read-only.** Claudometer observes Claude Code's own local state and CLI;
   it does not modify configuration, sessions, or credentials, and it does
   not talk to any network endpoint on its own.
4. **Native GNOME Shell UX.** Follows GNOME HIG for panel indicators
   (`St`/`Clutter` widgets, `PopupMenu` patterns), respects light/dark theme,
   and works across the GNOME Shell versions it declares support for in
   `metadata.json`.
5. **No accounts, no telemetry.** The extension has no backend of its own. It
   reads what Claude Code already knows on this machine and displays it.

## What Claudometer is NOT

- Not a Claude Code client — it does not send prompts, run tools, or start
  sessions. It only reads usage/status information.
- Not a general system-monitor extension — scope is Claude Code usage only.
- Not a replacement for `/usage`, `/cost`, or `/status` in the CLI — it is a
  glanceable summary, not a full accounting UI.
- Not a cloud dashboard — no server component, no account system, no data
  leaves the machine.

## Target Users

Developers who run Claude Code regularly across multiple terminals or
projects and want to see how close they are to a rate-limit window without
interrupting a session to check.

## Success Criteria

Claudometer succeeds when a user can:

- See current Claude Code usage at a glance from the GNOME top panel.
- Trust that checking usage never itself burns tokens or quota.
- Install it from a single extension package with no configuration required
  beyond what GNOME Extensions already provides.
