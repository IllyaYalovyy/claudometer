# RFC-003: Promote the COSMIC applet to the project root

| Field | Value |
|---|---|
| Status | Implemented |
| Author(s) | Illya Yalovyy |
| Supersedes | - |
| Superseded by | - |

## Summary

Promote the COSMIC feature branch to local main and move the applet crate to
the repository root. Preserve the previous main tip on a dedicated branch.

## Goals

- **G1** - Build the COSMIC applet from the repository root.
- **G2** - Keep only COSMIC files and platform-neutral infrastructure in the
  new main checkout.

## Non-Goals

- Change applet behavior, dependencies, or provider protocols.
- Rewrite Git history or update remote branches.

## Background and Motivation

The COSMIC applet is nested under `cosmic/` alongside a second implementation
and its release tooling. The project owner requested separate branches.

## User Impact

| Audience | Impact |
|---|---|
| End users | The applet's build and install instructions start at the root. |
| Contributors | The repository's quality gate checks the root Rust crate. |
| Operators / packagers | The Cargo manifest, install recipes, and assets live at the root. |

## Considered Options

### Option A - Promote the existing applet branch

Retains reviewable history and the original applet commits. Earlier commits
still contain both implementations.

### Option B - Create independent histories

Separates historical files as well, but discards existing ancestry and makes
the branch split harder to review and integrate.

## Decision

Use option A. The branch split applies to the checked-out tree and preserves
the previous main commit for rollback.

## Design

Move the crate and assets to the root. Retain only the fixtures the Rust suite
uses. Remove the other platform's code, tests, documentation, and packaging
scripts. Provision the Rust build prerequisites in CI and reuse the quality
gate. Rename the local branches after checking the new tree.

## Testing Strategy

| Risk / invariant | Test layer | Test name / location |
|---|---|---|
| Applet still builds from the root | Build | Cargo release build |
| Test fixture paths still resolve | Unit and integration | Existing Rust suite via the quality gate |
| Main contains only the applet | Repository inspection | Check staged files and preserved branch tip |

## Goals Alignment

| Goal | How addressed |
|---|---|
| G1 | Cargo and installation recipes live at the root. |
| G2 | Remove platform-specific files that the applet does not use. |

## Development Plan

- [x] Move the crate and update fixture references.
- [x] Update documentation and CI, then run available checks.
- [x] Commit the split and promote the local applet branch.

## Open Questions

None.

## References

- COSMIC applet feature branch
