# Claudometer for COSMIC™

A [COSMIC](https://system76.com/cosmic) panel applet that shows Claude Code
and Codex usage in the panel — how close each provider is to its current rate
limits — without ever starting a model turn to check.

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
  a model call; the CLI's JSON envelope is checked by the zero-cost
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

- A COSMIC desktop session with `cosmic-panel`.
- At least one locally installed and signed-in provider client (`claude`
  and/or `codex`). The applet looks on `PATH`, then in `~/.local/bin` and
  `~/bin`. API-key-only setups without subscription windows render as
  unavailable by design.

## Build and install from source

### 1. Install the build tools

**Rust (stable).** Use a current stable toolchain for the pinned libcosmic
dependencies. Install it with [rustup](https://rustup.rs):

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

**System libraries.** The applet links `libxkbcommon` and loads the Wayland
client libraries at runtime; libcosmic needs a C compiler and `pkg-config`
to build.

| Distribution | Packages |
|---|---|
| Pop!_OS / Ubuntu / Debian | `sudo apt install build-essential pkg-config git libxkbcommon-dev libwayland-dev` |
| Fedora | `sudo dnf install gcc pkgconf-pkg-config git libxkbcommon-devel wayland-devel` |
| Arch | `sudo pacman -S base-devel pkgconf git libxkbcommon wayland` |

**`just` (optional).** The recipes below use [`just`](https://github.com/casey/just)
(`cargo install just`, or your distribution's package). Every recipe has a
plain-shell equivalent further down, so `just` is a convenience, not a
requirement.

### 2. Get the source

```sh
git clone https://github.com/IllyaYalovyy/claudometer.git
cd claudometer
```

### 3. Build

```sh
just build-release          # equivalent: cargo build --release
```

The first build compiles libcosmic and takes a few minutes; later builds are
incremental. The binary lands at `target/release/cosmic-ext-applet-claudometer`.
On a machine without a usable GPU, build the software-rendering variant
instead:

```sh
just build-no-wgpu          # equivalent: cargo build --release --no-default-features
```

### 4. Install

System-wide (the panel finds it immediately):

```sh
sudo just install
```

Per-user, without root (COSMIC also reads applets from `~/.local/share`):

```sh
just prefix=$HOME/.local install
```

Without `just`, run the same four `install` commands by hand (replace
`/usr` with `$HOME/.local` for a per-user install):

```sh
APPID=io.github.illyayalovyy.cosmic-ext-applet-claudometer
PREFIX=/usr
sudo install -Dm0755 target/release/cosmic-ext-applet-claudometer "$PREFIX/bin/cosmic-ext-applet-claudometer"
sudo install -Dm0644 "data/$APPID.desktop" "$PREFIX/share/applications/$APPID.desktop"
sudo install -Dm0644 "data/icons/$APPID-symbolic.svg" "$PREFIX/share/icons/hicolor/scalable/apps/$APPID-symbolic.svg"
sudo install -Dm0644 "data/$APPID.metainfo.xml" "$PREFIX/share/metainfo/$APPID.metainfo.xml"
```

A per-user install needs `~/.local/bin` on the `PATH` of the COSMIC session
(it is by default on Pop!_OS), because the desktop entry starts the applet by
its bare command name.

### 5. Add the applet to the panel

1. Open **Settings → Desktop → Panel** (or **Dock**).
2. Choose **Configure panel applets**.
3. Find **Claudometer** and add it to a panel section.

A freshly installed applet may not appear in that list until you log out and
back in; restarting `cosmic-panel` alone is sometimes not enough. Once added,
the two meters show up immediately and the first fetch completes within a few
seconds. If a provider is not installed or signed out, its meter shows the
slashed unavailable state and the popup explains what to do.

### Upgrading

Pull the new source, rebuild, and reinstall with the same prefix:

```sh
git pull
just build-release
sudo just install            # or: just prefix=$HOME/.local install
```

Then remove the applet from the panel and add it again (or log out and back
in) so the panel restarts the new binary.

### Uninstalling

```sh
sudo just uninstall          # or: just prefix=$HOME/.local uninstall
```

This removes the binary, desktop entry, icon and metainfo. Settings stay
under `~/.config/cosmic/io.github.illyayalovyy.cosmic-ext-applet-claudometer/`;
delete that directory to reset them.

### Build troubleshooting

- **Cargo reports an unsupported edition or Rust version** — install or
  update the stable toolchain through rustup.
- **`failed to run custom build command` mentioning `xkbcommon` or
  `pkg-config`** — install the system packages from the table above.
- **The applet opens as a floating window instead of in the panel** — it was
  started outside `cosmic-panel`. Add it through Panel settings; do not run
  the binary by hand.
- **Nothing happens after adding it** — check the panel's journal for lines
  starting with `claudometer:`: `journalctl --user -f | grep claudometer`.

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

In `src/`, `claude.rs` and `codex.rs` hold the parsers,
fetchers and refresh policy, `model.rs` the pure render models, `marks.rs`
the generated SVG marks and meters, `scheduler.rs` the backoff state machine,
`config.rs` the cosmic-config settings, and `window.rs` the libcosmic
applet. Parser tests run against the captures in `tests/fixtures/`.

The offscreen render harness in `src/window.rs` is adapted from
[cosmic-ext-applet-codexbar](https://github.com/andrew-verde/cosmic-ext-applet-codexbar)
(MIT, Copyright (c) Andrew Verde).

## License

See [LICENSE](LICENSE) for the MIT license.
