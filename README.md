# Claudometer

A GNOME Shell extension that shows Claude Code and Codex usage in the top
panel — how close each provider is to its current rate limits — without ever
starting a model turn to check.

## What it shows

- Two compact symbol-and-meter pairs in the top panel: an original spark for
  Claude and generic code brackets for Codex. Each vertical meter shows the
  provider's most constrained window.
- A dropdown with every Claude and Codex window, including model-specific
  buckets, with progress bars, reset times, and per-provider freshness.
- A preferences window for alert thresholds and refresh cadence. Panel
  position and the compact representation are deliberately fixed.

Claudometer reads Claude Code's local usage state and asks the documented
Codex App Server account endpoint for Codex quota metadata. It never starts a
Claude or Codex model turn. See `VISION.md`,
`designs/RFC-001-usage-data-source.md`, and
`designs/RFC-002-multi-provider-usage.md` for the boundaries.

Requirements: GNOME Shell 49 and at least one locally installed provider
client. Claude Code and Codex are detected independently; a missing or signed
out provider is explicitly unavailable while the other keeps working.
API-key-only setups without subscription windows remain out of scope.

## Install

### From a release zip

Download `claudometer-v<version>.shell-extension.zip` from the
[releases page](https://github.com/IllyaYalovyy/claudometer/releases) and
run:

```bash
gnome-extensions install --force claudometer-v<version>.shell-extension.zip
```

GNOME Shell only discovers newly installed extensions at startup: on
Wayland, log out and log back in (on X11, restarting the shell with
Alt+F2, `r` also works). Then enable it:

```bash
gnome-extensions enable claudometer@illyayalovyy.github.io
```

### From source

```bash
git clone https://github.com/IllyaYalovyy/claudometer.git
cd claudometer
./scripts/package.sh
gnome-extensions install --force dist/claudometer-v*.shell-extension.zip
```

`scripts/package.sh` runs the full quality gate first and refuses to pack
if it fails. The artifact version comes from `version-name` in
`src/metadata.json`.

For the fast development loop (symlinked working tree, headless-Shell
manual testing, reading logs), see `docs/DEVELOPING.md`.

## Using Claudometer

Once enabled, the two compact meters appear in the top panel and need no
setup. Claudometer polls each installed provider every minute; each meter
shows whichever of that provider's rate-limit windows has the highest usage.

**What the indicator states mean:**

| You see | Meaning |
|---|---|
| Blue vertical fill | Normal — the fill is the provider's highest percent used |
| Yellow fill | Warning — 80% used (threshold configurable) |
| Red fill | Critical or limit reached — 95% or more used |
| Dimmed symbol and meter | That provider's last known data is stale |
| Dimmed slashed empty meter | That provider is unavailable; the other remains independent |

**Click the meters** for detail: one section per Claude or Codex window
with a progress bar and reset time, plus a footer showing freshness for both
providers and a manual refresh button. The
menu is fully keyboard-operable (arrows, Enter on the footer refreshes,
Esc closes).

**Preferences** (Extensions app → Claudometer → settings, or
`gnome-extensions prefs claudometer@illyayalovyy.github.io`):

- *Warning / Critical at* — the state thresholds (kept strictly ordered)
- *Interval* — poll cadence, 30 s to 10 min

All changes apply immediately; no re-enable needed.

### Troubleshooting

- **"Claude Code was not found on this system."** — Claudometer reads a
  local Claude Code installation. Install it, run `claude` once, and hit
  the refresh button in the dropdown.
- **"Can't read usage data."** — Claude Code is installed but signed out
  (or has no usage cache yet). Open `claude`, sign in, then refresh.
  API-key-only (pay-per-token) setups show this state permanently by
  design — there are no rate-limit windows to display.
- **"Codex was not found on this system."** — Install the Codex CLI and hit
  refresh. If it is installed but unavailable, open Codex, sign in with your
  ChatGPT account, then refresh.
- **Stale (dimmed) more often than expected** — the Claude CLI throttles
  rewrites of its local usage cache (a few minutes between updates is
  normal). Brief stale windows on a working setup are a known cosmetic
  issue ([#16](https://github.com/IllyaYalovyy/claudometer/issues/16)).
- **Data stays stale and the journal says "disabling the CLI refresh
  path"** — the zero-token tripwire fired: a refresh could not prove it
  made no model calls, so Claudometer stopped running the CLI (across
  restarts too) and only reads the local cache. If you have verified the
  cause — typically a CLI update, see the journal line — re-enable
  explicitly:

  ```bash
  gsettings set org.gnome.shell.extensions.claudometer refresh-path-disabled false
  ```

- Diagnostics land in the journal, never in the menu:
  `journalctl -f -o cat /usr/bin/gnome-shell | grep -i claudometer`.

**The no-model-turn guarantee:** checking usage never starts a model turn.
The Claude path reads a local cache; its optional `claude -p "/usage"`
refresh is guarded by the existing zero-token tripwire. The Codex path starts
`codex app-server` only long enough to call the documented read-only
`account/rateLimits/read` method; it never starts a thread or turn.

## Status

The MVP plus RFC-002's Claude/Codex panel meters and multi-provider dropdown
are implemented. The data sources are decided in
`designs/RFC-001-usage-data-source.md` and
`designs/RFC-002-multi-provider-usage.md`. The original MVP work is tracked
in the [MVP milestone](https://github.com/IllyaYalovyy/claudometer/milestone/1).
Known follow-up work from the post-MVP review is tracked under the
[`post-mvp` label](https://github.com/IllyaYalovyy/claudometer/labels/post-mvp).

## Contributing

See `CONTRIBUTING.md` for the working rules and quality bar. If you clone
this repository fresh, install the local AI-file commit guard (it lives in
`.git/hooks/`, which `git clone` never carries):

```bash
./scripts/install-git-hooks.sh
```

### Project Workflow

The default workflow is intentionally simple:

1. Write or update the user task / problem statement.
2. Create an RFC for broad, irreversible, cross-cutting, or dependency-adding
   changes.
3. Implement in small reviewable steps.
4. Add tests at the layer where the risk lives.
5. Run `./scripts/quality.sh`.
6. Review for behavior, regressions, secrets, and maintainability before merge.

### Repository Layout

```text
.
├── AGENTS.md                    # Instructions for AI coding agents
├── CONTRIBUTING.md              # Contributor rules and quality bar
├── VISION.md                    # Problem, approach, and what this is not
├── designs/
│   ├── RFC-001-usage-data-source.md  # Decided: zero-token data source
│   ├── RFC-002-multi-provider-usage.md # Claude + Codex source/UI design
│   ├── UX-DESIGN.md             # Panel indicator + dropdown UX design
│   └── USER-TASKS.md            # User workflow inventory
├── docs/
│   ├── DEVELOPING.md            # Dev loop: install, headless Shell, logs
│   ├── PROCESS.md               # How work moves from idea to merge
│   ├── COMMITS.md               # Commit identity, staging, and message rules
│   ├── TESTING.md               # Testing strategy
│   ├── RELEASE.md               # Release checklist
│   └── prompts/                 # Copy-ready AI prompts for common workflows
├── src/                         # The extension (lib/ is pure, gjs-testable)
├── tests/                       # Headless unit tests + committed fixtures
└── scripts/
    ├── quality.sh               # Local quality gate (hooks in quality.d/)
    └── package.sh               # Build the installable release zip
```

### Quality Gate

Run the local quality gate before asking for review:

```bash
./scripts/quality.sh
```

It checks shell syntax, `metadata.json`, the GSettings schema, JS syntax,
the committed fixtures, and runs the headless unit tests. Project-specific
checks live as executable files under `scripts/quality.d/`.

### Design Documents

Use `designs/RFC-000-template.md` for changes that are hard to reverse,
touch multiple parts of the system, add dependencies, or change external
behavior. Use `designs/USER-TASKS.md` to keep user-facing workflows
explicit and testable.

This repository was initialized from `ai-proj-template`; see
`docs/TEMPLATE-RATIONALE.md` for the practices it carries.

### AI Prompt Templates

Reusable prompts live in `docs/prompts/`:

- `task.md` - turn a request into a scoped task
- `rfc.md` - draft or revise an RFC
- `implement.md` - implement accepted work
- `review.md` - review a diff or branch
- `commit.md` - prepare a clean commit

### Task Tracking

Work toward the MVP is tracked as GitHub issues under the
[MVP milestone](https://github.com/IllyaYalovyy/claudometer/milestone/1),
ordered by dependency. Each issue is a self-contained specification with
acceptance criteria and test requirements; the issue body is the source of
truth for its task, and completed tasks are closed with a completion report
comment.

### AI Task Runner (local only)

This project uses `ktask`, a local project-agnostic AI CLI task orchestrator,
to drive queued implementation tasks. `ktask init` creates `.ktask/` in the
repository root; it is gitignored and blocked by the pre-commit guard, so it
never reaches the remote. Anyone working on this repo runs `ktask init`
locally to recreate it — see `ktask --help` or the tool's own README.
