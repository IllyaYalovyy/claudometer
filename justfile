rootdir := ''
prefix := '/usr'
debug := '0'
target := if debug == '1' { 'debug' } else { 'release' }
debug_args := if debug == '1' { '' } else { '--release' }

name := 'cosmic-ext-applet-claudometer'
appid := 'io.github.illyayalovyy.cosmic-ext-applet-claudometer'

targetdir := env('CARGO_TARGET_DIR', 'target')
sharedir := rootdir + prefix + '/share'
iconsdir := sharedir + '/icons/hicolor/scalable/apps'
metainfodir := sharedir + '/metainfo'
bindir := rootdir + prefix + '/bin'

default: build-release

# Compiles with debug profile
build-debug *args:
    cargo build {{args}}

# Compiles with release profile
build-release *args: (build-debug '--release' args)

# Compiles with release profile with wgpu disabled (software rendering)
build-no-wgpu *args: (build-debug '--release --no-default-features' args)

# Runs the unit tests
test:
    cargo test

# Runs the quality gate: formatting, lints, tests
check:
    cargo fmt --check
    cargo clippy --all-targets -- -D warnings
    cargo test

# Renders popup/panel states to PNG files under `out` for visual review
render out='/tmp/claudometer-render':
    CLAUDOMETER_RENDER_DIR={{out}} cargo test render_states -- --ignored
    for f in {{out}}/*.pam; do magick "$f" "${f%.pam}.png"; done

_install_icon:
    install -Dm0644 'data/icons/{{appid}}-symbolic.svg' {{iconsdir}}/{{appid}}-symbolic.svg

_install_desktop:
    install -Dm0644 'data/{{appid}}.desktop' {{sharedir}}/applications/{{appid}}.desktop

_install_metainfo:
    install -Dm0644 'data/{{appid}}.metainfo.xml' {{metainfodir}}/{{appid}}.metainfo.xml

_install_bin:
    install -Dm0755 {{targetdir}}/{{target}}/{{name}} {{bindir}}/{{name}}

# Installs files into the system (use `just prefix=$HOME/.local install` for a user install)
install: _install_icon _install_desktop _install_metainfo _install_bin

# Uninstalls the applet from the system
uninstall:
    rm -f {{bindir}}/{{name}}
    rm -f {{iconsdir}}/{{appid}}-symbolic.svg
    rm -f {{sharedir}}/applications/{{appid}}.desktop
    rm -f {{metainfodir}}/{{appid}}.metainfo.xml
