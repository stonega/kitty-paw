# AGENTS.md

This document defines how AI agents should work in this repository.

## Project structure

- `src/` contains the GNOME Shell extension source. It must remain directly
  packageable by `gnome-extensions pack`.
- `tests/` contains deterministic unit and integration tests.
- `scripts/` contains idempotent development, packaging, installation, and
  test helpers.
- `docs/design/` documents architecture and design decisions.
- `docs/implementation/` documents developer setup and implementation detail.
- `docs/user/` contains end-user setup and troubleshooting material.
- `examples/` contains runnable configuration examples.
- `postmortem/` is reserved for incident reports.
- `dist/` contains generated extension bundles and is not committed.

Preserve this layout. Read the relevant design and implementation documents
before changing runtime behavior.

## Runtime constraints

- Target GNOME Shell 50 and modern GJS ES modules.
- Do not use Node.js or Bun APIs from extension runtime code.
- Keep code running inside GNOME Shell asynchronous and bounded; never block
  the Shell process on subprocess or filesystem work.
- Spawn Kitty commands with `Gio.Subprocess` argument arrays. Never construct a
  shell command from user settings.
- Treat Kitty session files as private user state and retain the last complete
  snapshot whenever a capture fails.
- Every signal, timeout, cancellable, subprocess, and panel actor created by
  `enable()` must be cleaned up by `disable()`.
- Do not modify the user's Kitty configuration automatically.

## Development workflow

1. Read `docs/design/architecture.md` and `docs/implementation/setup.md`.
2. Implement runtime code in `src/`.
3. Add or update tests in `tests/`.
4. Update user and implementation documentation with behavior changes.
5. Run `bun run check`, `bun test`, and `bun run package` before finishing.

## Coding rules

- Keep modules small, composable, and dependency-injectable where practical.
- Prefer explicit state transitions over implicit actor or process state.
- Keep persistent settings and manifest formats backward compatible, or add an
  explicit migration.
- Use Biome for repository JavaScript and JSON formatting.
- Do not add runtime dependencies or frameworks without a concrete need.

## Testing requirements

- New behavior requires deterministic tests.
- Unit-test pure policy and state logic with Bun.
- Test process and filesystem workflows with isolated temporary directories
  and fake executables; never depend on the user's live Kitty session.
- Package the extension as part of verification.
- Use `gnome-shell-test-tool` for GNOME integration smoke tests when available.

## Documentation and examples

- Architecture changes belong in `docs/design/`.
- Setup and internals belong in `docs/implementation/`.
- User-facing behavior belongs in `docs/user/`.
- Runnable Kitty configuration belongs in `examples/`.
- Preserve third-party icon attribution and licensing notices.

## Version control and safety

- Prefer `git`; use `gh` only when Git is insufficient.
- Preserve unrelated user changes.
- Never delete user session state or modify Kitty configuration as part of
  tests, installation, or uninstallation.
- Do not commit generated `dist/`, compiled schemas, coverage, or caches.
