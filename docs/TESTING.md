# Testing Strategy

This project values tests that protect user behavior and system invariants over
raw coverage percentages.

## Test Layers

Use the lowest layer that catches the risk clearly:

- **Unit tests** - pure functions, model invariants, parsing, validation,
  reducers, state transitions
- **Integration tests** - storage, API clients, process boundaries, migrations,
  serialization compatibility, concurrency contracts
- **UI / behavioral tests** - user flows, keyboard and pointer behavior,
  accessibility-visible state, layout regressions
- **Property / fuzz tests** - parsers, protocols, tree structures, state
  machines, and untrusted input
- **Manual checks** - hardware, external providers, stores, or other cases where
  automation is not practical

## Regression Rule

Every fixed bug should leave behind a test that fails without the fix.

Every new user-facing behavior should have a test that would fail if the behavior
disappeared.

## Risk Matrix

The rows this project settled on (VISION G1 first — it is the reason the
project exists):

| Risk / failure mode | User impact | Test layer | Coverage |
|---|---|---|---|
| A refresh spends Claude tokens (G1) | The meter costs what it measures | Unit + gate | `fetcher.test.js` zero-cost envelope assertions, `source.test.js::model_invoked_permanently_disables_the_refresh_path` plus its persisted-flag suite (`persisted_disable_holds_from_the_first_fetch`, `explicit_re_enable_re_arms_the_refresh_path_and_the_tripwire`), `scripts/quality.d/50-fixtures` invariants every gate run |
| CLI cache schema drift | Wrong or fabricated numbers | Unit | `snapshot.test.js` strict-parse taxonomy (wrong-typed field ⇒ whole payload UNPARSEABLE, never coerced) |
| Missing/unreadable/signed-out data shown as `0%` | Honesty failure (UX §1) | Unit + manual | `indicator_model.test.js::unavailable_shows_no_number_anywhere_in_any_mode`, `menu_model.test.js` §4.5 notices, SMOKE-TEST items 14–16 |
| Stale data presented as current | User trusts an hour-old number | Unit + manual | `derive.test.js` stale precedence, `indicator_model.test.js` dimming/qualifier, SMOKE-TEST item 17 |
| Fetch failure breaks the poll loop | Indicator freezes silently | Unit | `scheduler.test.js` (error snapshots engage backoff; rejecting fetch surfaces as unavailable, never throws into the mainloop) |
| Eternal no-op CLI spawns on signed-out/API-key setups (#19) | Battery/CPU spent on a source that cannot recover by itself (VISION principle 2) | Unit | `source.test.js::signed_out_polls_stop_spawning_after_max_ineffective_refreshes` plus its re-arm suite (`manual_refresh_spawns_while_suspended_and_re_arms_auto_refreshes`, `sign_in_after_give_up_re_arms_the_stale_refresh_path`); menu opens must not re-open the loop (#23): `degraded_pipeline.test.js::menu_open_after_give_up_neither_spawns_nor_re_arms`, `scheduler.test.js::only_the_refresh_button_fetch_is_flagged_manual` |
| Raw error strings reach the menu | Unreadable UI, leaked paths | Unit | `menu_model.test.js::raw_error_strings_never_surface_in_the_menu_model` |
| Garbage GSettings values (CLI writes) | Broken thresholds/cadence | Unit | `settings_model.test.js` normalize/cross-clamp suite, `settings_live.test.js` |
| enable/disable leaks timers or signals | Shell degrades over sessions | Unit + manual | `scheduler.test.js` stop/lifecycle tests, `login1.test.js` bus-unsubscribe tests, SMOKE-TEST item 19 (cycle + soak) |
| Widget behavior only a Shell can show (focus, keyboard, a11y names, theme) | Inaccessible or illegible UI | Manual | `docs/SMOKE-TEST.md` items 7–13, 20–28 |

## Local Quality Gate

Run:

```bash
./scripts/quality.sh
```

Add project-specific checks as executable files in `scripts/quality.d/`.

## Test Naming

Prefer names that describe the requirement:

```text
restores_workspace_after_process_restart
rejects_expired_token_without_overwriting_refresh_token
keeps_keyboard_focus_after_item_delete
```

Avoid names that only describe the implementation:

```text
test_update
manager_returns_true
component_renders
```
