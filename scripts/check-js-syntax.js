// Parse-only syntax check for extension JS, run as:
//   gjs -m scripts/check-js-syntax.js FILE...
//
// gjs has no parse-only flag, but ES modules are parsed before their
// imports are resolved, so dynamic import() surfaces a SyntaxError for a
// parse failure in the named file, while unresolvable imports (gi://St,
// resource:///... — unavailable outside a running Shell) throw ordinary
// Errors after a successful parse and are tolerated here.
import system from 'system';
import Gio from 'gi://Gio';

let failures = 0;
for (const path of system.programArgs) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null)) {
        printerr(`syntax-check: ${path}: file not found`);
        failures += 1;
        continue;
    }
    try {
        await import(file.get_uri());
    } catch (e) {
        if (e instanceof SyntaxError) {
            printerr(`syntax-check: ${path}:${e.lineNumber}: ${e.message}`);
            failures += 1;
        }
    }
}
system.exit(failures > 0 ? 1 : 0);
