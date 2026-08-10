# Claudometer — Vision

## The Problem

Claude Code and Codex usage are metered in ways that are easy to lose track
of: short rolling windows, weekly limits, and model-specific buckets,
depending on plan. Their usage views live inside separate coding clients.
There is no single ambient, always-visible way to compare them while working
in other windows.

## The Solution

Claudometer is a GNOME Shell extension that surfaces Claude Code and Codex
usage in the top panel: one compact symbol-and-meter pair per provider, with a
dropdown for rolling-window usage, plan limits, and reset times.

**Core principles:**

1. **No model cost, by construction.** The extension must never start a model
   turn or consume model output to report usage. Every provider source must
   be a local read or a documented metadata-only account query — never a
   prompt sent to a model. See `designs/RFC-001-usage-data-source.md` and
   `designs/RFC-002-multi-provider-usage.md` for the provider boundaries.
2. **Ambient, not intrusive.** A glance at the panel is enough. No polling
   loop should be aggressive enough to matter for battery or CPU; no popup
   should interrupt work uninvited.
3. **Read-only.** Claudometer observes each coding client's own state and
   read-only account interface. It does not modify configuration, sessions,
   credits, or credentials, and it does not talk to provider network
   endpoints on its own.
4. **Native GNOME Shell UX.** Follows GNOME HIG for panel indicators
   (`St`/`Clutter` widgets, `PopupMenu` patterns), respects light/dark theme,
   and works across the GNOME Shell versions it declares support for in
   `metadata.json`.
5. **No accounts, no telemetry.** The extension has no backend of its own. It
   reads what Claude Code already knows on this machine and displays it.

## What Claudometer is NOT

- Not a Claude Code or Codex client — it does not send prompts, run tools, or
  start sessions. It only reads usage/status metadata.
- Not a general system-monitor extension — scope is supported coding-agent
  subscription usage only.
- Not a replacement for provider usage/cost/status views — it is a glanceable
  summary, not a full accounting UI.
- Not a cloud dashboard — no server component, no account system, no data
  leaves the machine.
- Not an API-key cost meter — Claudometer is for subscription plans and
  their rate-limit windows (session/weekly percentages, reset times).
  Pay-per-token API metering is a different problem with different data and
  a different UI, and is permanently out of scope.

## Target Users

Developers on Claude and/or ChatGPT subscription plans who use Claude Code or
Codex across multiple terminals and projects and want to see how close each
provider is to a rate-limit window without interrupting a session to check.

## Success Criteria

Claudometer succeeds when a user can:

- See current Claude Code and Codex usage at a glance from the GNOME panel.
- Trust that checking usage never itself starts a model turn or burns model
  quota.
- Install it from a single extension package with no configuration required
  beyond what GNOME Extensions already provides.
