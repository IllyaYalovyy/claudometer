# Developing Claudometer

How to run the extension from a working tree, test it in a throwaway
headless GNOME Shell, and read its logs. Target platform: GNOME Shell 49, Wayland.

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

## Manual testing in a throwaway session

Never iterate on your live session — a broken `enable()` can degrade the
Shell you are working in. GNOME Shell 49 removed `--nested`; run a
throwaway headless Shell instead (from a terminal inside your normal
session):

```bash
GSETTINGS_BACKEND=memory dbus-run-session -- sh -c \
    'echo "$DBUS_SESSION_BUS_ADDRESS" >/tmp/nested-bus; \
     exec gnome-shell --headless --virtual-monitor 1280x720 --unsafe-mode'
```

This runs a complete, throwaway GNOME Shell that reads the same extensions
directory. `GSETTINGS_BACKEND=memory` keeps it from touching your live
session's dconf (which also means the `gnome-extensions` CLI cannot enable
the extension there — it writes dconf). Drive it over its own D-Bus
instead:

```bash
export DBUS_SESSION_BUS_ADDRESS=$(cat /tmp/nested-bus)
gdbus call --session --dest org.gnome.Shell \
    --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Extensions.EnableExtension \
    "claudometer@illyayalovyy.github.io"
```

`--unsafe-mode` enables `org.gnome.Shell.Eval` for poking at the running
Shell (opening the menu, taking screenshots via `Shell.Screenshot`).
Killing the `gnome-shell` process discards the session.

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
