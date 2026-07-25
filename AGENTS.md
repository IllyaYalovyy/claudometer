# AI Agent Instructions

These instructions apply to AI coding agents working in this repository.

## Operating Principles

- Read existing code and docs before proposing architecture.
- Prefer the repository's established patterns over new abstractions.
- Keep changes scoped to the task. Do not perform unrelated cleanup.
- Preserve user changes. Never revert files you did not intentionally modify.
- Use fast search tools such as `rg` before slower recursive commands.
- Add tests with the change unless the reason not to is explicit.
- Run `./scripts/quality.sh` before declaring implementation complete when
  practical.

## Standard Workflow

1. **Understand** - read the request, relevant docs, existing code, tests, and
   open design records.
2. **Classify** - decide whether this is a small task, bug fix, RFC-required
   change, review, or commit-prep request.
3. **Plan** - for non-trivial work, state the concrete steps and test strategy.
4. **Implement** - keep edits scoped and preserve unrelated user changes.
5. **Verify** - run focused checks first, then `./scripts/quality.sh` when
   practical.
6. **Handoff** - summarize changed behavior, files, checks, skipped checks, and
   residual risks.

## Planning and Design

Use an RFC before implementation when the change:

- Touches multiple subsystems
- Adds or replaces dependencies
- Changes persistence, API, protocol, auth, or public behavior
- Is difficult to reverse

Use `designs/RFC-000-template.md` and keep the development plan updated as steps
complete.

Design review rules live in `docs/DESIGN-REVIEW.md`.

## Implementation Rules

- Keep commits and patches reviewable.
- Do not hard-code local paths, usernames, hostnames, secrets, or tokens.
- Do not commit agent working directories, task-runner state, prompts, context
  files, scratchpads, or chat logs. These are local-only and must not leak to
  the remote repository.
- Make failures explicit. Prefer errors with context over silent fallback.
- For UI work, verify real behavior, not only component existence.

## Commit Rules

- Read `docs/COMMITS.md` before preparing a commit.
- Verify `git config user.name` and `git config user.email`.
- Keep the local AI-file pre-commit guard installed by running
  `./scripts/install-git-hooks.sh` after cloning or reinitializing the project.
- Inspect the staged diff before committing.
- Keep commits coherent and reversible.
- Do not push unless explicitly instructed.

## Prompt Templates

Reusable prompts live in `docs/prompts/`:

- `task.md` - clarify and execute a task
- `rfc.md` - draft or revise an RFC
- `implement.md` - implement accepted work
- `review.md` - review a diff or branch
- `commit.md` - prepare a commit

## Review Before Handoff

Before handing work back:

- Summarize changed files and behavior.
- State which tests or checks were run.
- State any checks that were skipped and why.
- Call out remaining risks or follow-up work.
