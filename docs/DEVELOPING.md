# Developing Claudometer

How to run the extension from a working tree, test it in a nested GNOME
Shell, and read its logs. Target platform: GNOME Shell 49, Wayland.

## Install from the working tree

The extension sources live in `src/`. GNOME Shell loads extensions from
`~/.local/share/gnome-shell/extensions/<uuid>/`, where `<uuid>` must match
the `uuid` field in `metadata.json` (`claudometer@illyayalovyy.github.io`).

The fastest dev loop is a symlink, so edits are picked up on the next
Shell/extension reload without reinstalling:

```bash
ln -sfnT "$(pwd)/src" \
    ~/.local/share/gnome-shell/extensions/claudometer@illyayalovyy.github.io
```

Alternatively, build and install a proper zip (what a release would ship):

```bash
gnome-extensions pack src/ --force --out-dir=/tmp
gnome-extensions install --force /tmp/claudometer@illyayalovyy.github.io.shell-extension.zip
```

Then enable/disable with:

```bash
gnome-extensions enable claudometer@illyayalovyy.github.io
gnome-extensions disable claudometer@illyayalovyy.github.io
gnome-extensions info claudometer@illyayalovyy.github.io   # state + errors
```

## Manual testing in a nested session

Never iterate on your live session — a broken `enable()` can degrade the
Shell you are working in. Run a nested Shell instead (from a terminal
inside your normal session):

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

This opens a window containing a complete, throwaway GNOME Shell that reads
the same extensions directory. Inside it, open a terminal (or use the
`gnome-extensions` CLI from outside with `DBUS_SESSION_BUS_ADDRESS` of the
nested session) and enable the extension. Closing the window discards the
session.

Useful variations:

- `MUTTER_DEBUG_DUMMY_MODE_SPECS=1280x720 dbus-run-session -- gnome-shell --nested --wayland`
  to control the nested window size.
- `dbus-run-session -- gnome-shell --headless --virtual-monitor 1280x720`
  for a display-less run (CI-ish smoke checks; interact via D-Bus).

## Reading logs

GNOME Shell (and therefore extension) output goes to the journal:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

For a nested session started from a terminal, errors also print directly to
that terminal's stderr. Watch for `JS ERROR` lines mentioning the extension
UUID — a clean enable/disable cycle must produce none.

For `prefs.js` (which runs in a separate process, not the Shell):

```bash
journalctl -f -o cat /usr/bin/gjs
```

## Unit tests and the quality gate

Unit tests run headlessly, without a Shell, under plain `gjs -m`:

```bash
./tests/run-tests.sh    # just the unit tests
./scripts/quality.sh    # full gate: metadata check, JS syntax, tests, hooks
```

Pure logic belongs in `src/lib/` modules with no St/Clutter/Shell imports
so it stays importable under plain `gjs` — see `docs/TESTING.md` and the
`test-quality` skill. Shell-coupled code (indicator, menu) stays thin and
is verified manually in the nested session.
