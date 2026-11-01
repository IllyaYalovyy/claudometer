# Claudometer for COSMIC™

A [COSMIC](https://system76.com/cosmic) panel applet that shows Claude Code
and Codex usage in the panel — how close each provider is to its current rate
limits — without ever starting a model turn to check. It is the COSMIC port of
the GNOME Shell extension in the parent directory and follows the same design
documents: `../VISION.md`, `../designs/UX-DESIGN.md`,
`../designs/RFC-001-usage-data-source.md` and
`../designs/RFC-002-multi-provider-usage.md`.

This is a third-party applet. It is not official COSMIC software and is not
endorsed by System76. COSMIC™ is a trademark of System76, Inc.

## What it shows

- Two compact symbol-and-meter pairs in the panel: an original warm bloom
  evoking Claude and an original teal neural ring evoking Codex, each beside a
  narrow vertical meter filled from the bottom to that provider's constraint
  (Claude: its highest window; Codex: its main included-usage bucket only).
  The pair has a fixed footprint in every state, so loading, stale and
  unavailable transitions never make the panel breathe.
- A fixed-width popup with every Claude and Codex window, including
  model-specific buckets: provider heading, one compact section per window
  (title, bar, percentage, reset time), Codex bucket names once above their
  duration rows, earned rate-limit resets as quiet metadata, and a footer with
  per-provider freshness, a refresh button and a settings button.
- Inline settings: warning and critical thresholds, poll interval, and the
  zero-token tripwire re-arm. Changes apply live and persist through
  cosmic-config.

| You see | Meaning |
|---|---|
| Accent-colored vertical fill | Normal — Claude's highest percent or Codex's main included-usage percent |
| Warning-colored fill | Warning — 80% used (threshold configurable) |
| Error-colored fill | Critical at 95%+, or an explicit Codex reached/blocked state |
| Dimmed symbol and meter | That provider's last known data is stale (older than 3× the poll interval) |
| Dimmed slashed empty meter | That provider is unavailable; the other remains independent |

Hovering the strip shows the full story as a tooltip (percent, reset time,
staleness, reached states) — the applet never shows a number its data source
did not provide.

## Data sources and the no-model-turn guarantee

- **Claude Code** — reads the `cachedUsageUtilization` object in
  `~/.claude.json`. When that cache is older than the poll interval the applet
  runs `claude -p /usage --output-format json`, which the CLI handles without
  a model call; the CLI's JSON envelope is checked by the RFC-001 zero-cost
  tripwire and never parsed for data. If an envelope ever fails to prove zero
  model cost, the refresh path is disabled, persisted across restarts, and
  only re-enabled from the settings page.
- **Codex** — starts `codex app-server` only long enough to send
  `initialize`, `initialized` and `account/rateLimits/read`, then stops it.
  No thread or turn is ever started.

Both reads run concurrently on the applet's executor thread; the panel keeps
its previous state until a new snapshot lands. Unavailable providers back off
(1 → 2 → 5 min) and give up re-spawning after three ineffective attempts
until the next manual refresh. Opening the popup refreshes implicitly if the
last fetch is older than 15 s.

## Requirements

- A COSMIC desktop session (this is a `cosmic-panel` applet).
- Rust (stable) and, optionally, [`just`](https://github.com/casey/just).
- At least one locally installed and signed-in provider client (`claude`
  and/or `codex`). The applet looks on `PATH`, then in `~/.local/bin` and
  `~/bin`. API-key-only setups without subscription windows render as
  unavailable by design.

## Build and install

```sh
cd cosmic
just build-release          # or: cargo build --release
sudo just install           # or: just prefix=$HOME/.local install
```

`install` places the binary in `<prefix>/bin`, the desktop entry in
`<prefix>/share/applications`, the symbolic icon in
`<prefix>/share/icons/hicolor/scalable/apps` and the metainfo in
`<prefix>/share/metainfo`. Then add the applet from **Settings → Desktop →
Panel → Configure panel applets** (a new applet may only appear in that list
after logging out and back in). On systems without a usable GPU, build with
`just build-no-wgpu` for software rendering.

## Settings

Click the gear in the popup footer:

- **Warning at / Critical at** — the state thresholds (kept strictly ordered).
- **Interval** — poll cadence, 30 s to 10 min. The stale boundary follows it
  (3× the interval).
- **Re-enable refresh** — appears only after the zero-token tripwire fired.

Values are stored under `~/.config/cosmic/io.github.illyayalovyy.cosmic-ext-applet-claudometer/v1/`
and the applet reloads them live. Times honor the COSMIC clock applet's
12/24-hour setting.

## Troubleshooting

- **"Claude Code was not found on this system."** — install Claude Code, run
  `claude` once, then press refresh.
- **"Can't read Claude Code usage data."** — Claude Code is installed but
  signed out or has no usage cache yet. Open `claude`, sign in, then refresh.
- **"Codex was not found on this system."** / **"Can't read Codex usage
  data."** — install Codex, or open it and sign in with your ChatGPT account,
  then refresh.
- **Stale (dimmed) more often than expected** — the Claude CLI throttles
  rewrites of its usage cache (a few minutes between updates is normal).
- **Data stays stale and the settings page offers "Re-enable refresh"** — the
  zero-token tripwire fired. Check the panel's journal (`journalctl --user -f`
  and look for `claudometer:` lines) for the cause before re-enabling.

Diagnostics go to stderr (the panel's journal), never into the popup.

## Development

```sh
cargo test                       # parsers, models, scheduler, layout checks
just check                       # fmt + clippy + tests
just render /tmp/claudometer     # offscreen PNGs of popup and panel states
```

`src/` mirrors `../src/lib/`: `claude.rs` and `codex.rs` hold the parsers,
fetchers and refresh policy, `model.rs` the pure render models, `marks.rs`
the generated SVG marks and meters, `scheduler.rs` the backoff state machine,
`config.rs` the cosmic-config settings, and `window.rs` the libcosmic
applet. Parser tests run against the captures in `../tests/fixtures/`.

The offscreen render harness in `src/window.rs` is adapted from
[cosmic-ext-applet-codexbar](https://github.com/andrew-verde/cosmic-ext-applet-codexbar)
(MIT, Copyright (c) Andrew Verde).

## License

MIT, like the rest of the repository. See `../LICENSE`.
