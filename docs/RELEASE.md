# Release Checklist

Use this checklist when preparing a Claudometer release.

## Versioning and artifact

The version lives in one place: `"version-name"` in `src/metadata.json`
(dotted numeric, e.g. `0.1.0`). Everything else derives from it.

Build the artifact with:

```bash
./scripts/package.sh
```

which runs `./scripts/quality.sh` (and refuses to pack on a red gate),
packs `src/` with `gnome-extensions pack`, verifies the zip contains every
source file, and writes:

```text
dist/claudometer-v<version>.shell-extension.zip
```

The zip ships the GSettings schema as XML only; `gnome-extensions install`
compiles `gschemas.compiled` at install time (verified on GNOME Shell 49).

## Before Release

- [ ] Bump `version-name` in `src/metadata.json`.
- [ ] Update release notes.
- [ ] Run `./scripts/package.sh` (includes the quality gate).
- [ ] Install the built zip from a clean state and smoke-test it:
      `gnome-extensions uninstall claudometer@illyayalovyy.github.io`,
      `gnome-extensions install --force dist/claudometer-v<version>.shell-extension.zip`,
      then enable in a throwaway Shell session and run
      `docs/SMOKE-TEST.md` — clean enable/disable, no `JS ERROR` lines
      for the UUID in the journal.
- [ ] Verify docs (README install steps, `docs/DEVELOPING.md`) describe the
      released behavior.
- [ ] Confirm no secrets, local paths, or agent files are staged.

## Release Notes

Include:

- User-visible changes
- Bug fixes
- Breaking changes or migrations
- Known issues
- Upgrade or rollback notes

## After Release

- [ ] Tag the release: `git tag v<version> && git push origin v<version>`.
- [ ] Publish `dist/claudometer-v<version>.shell-extension.zip` as a GitHub
      release asset.
- [ ] Download the published asset and verify
      `gnome-extensions install --force` succeeds from it.
- [ ] Open follow-up issues for deferred work.
