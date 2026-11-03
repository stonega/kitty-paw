# Developer setup

## Toolchain

Install GNOME Shell 50 development tools, Kitty, Kitten, Bun, `unzip`, and
`glib-compile-schemas`. The extension uses modern GJS modules and does not need
a JavaScript bundler.

Install the development dependency:

```bash
bun install
```

## Commands

- `bun run lint` checks JavaScript, JSON, and SVG files with Biome.
- `bun test` runs pure policy tests.
- `bun run test:gjs` runs Gio subprocess and snapshot-store integration tests
  against isolated fake Kitty executables.
- `bun run validate:schema` validates GSettings without writing a compiled
  schema into the source tree.
- `bun run package` creates and inspects the extension bundle.
- `bun run smoke` packages the extension and loads it in a headless GNOME Shell
  50 compositor to verify that the paw indicator registers.
- `bun run install:local` packages, installs, and enables the extension for the
  current user.

## Runtime debugging

Follow Shell logs while enabling or exercising the extension:

```bash
journalctl --user -f -o cat | rg 'Kitty Session Restorer|gnome-shell'
```

Inspect the installed extension with:

```bash
gnome-extensions info kitty-session-restorer@stone.dev
```

GNOME Wayland sessions cannot restart Shell in place. Log out and back in after
installing a new extension version when GNOME does not pick it up dynamically.

## Implementation constraints

- Do not import Gtk or Adw from `extension.js`; they belong only in `prefs.js`.
- Keep subprocess calls asynchronous and pass explicit argument arrays.
- Never overwrite the active snapshot until every Kitty instance saves.
- Use asynchronous Gio filesystem operations for snapshot state, including
  metadata checks and cleanup. `SnapshotStore.capture()` and `loadCurrent()`
  both return promises and accept a `cancellable` option owned by the controller.
- Keep the manifest backward compatible or introduce a versioned migration.
- Never change the user's Kitty configuration from extension code.

The GJS performance regression tests reject synchronous filesystem calls during
snapshot workflows, verify private permissions and recovery after cancellation,
and check save coalescing and restore guards while IO is pending. All fixtures
use temporary directories; they do not access live Kitty sessions.

## Workspace restoration

Workspace indexes are captured from Mutter together with each Kitty process and
stored in the snapshot manifest. During restore, the window tracker polls for
the expected new Kitty windows for at most 15 seconds, orders them by Mutter's
stable creation sequence, creates any missing GNOME workspaces, and moves the
windows through `Meta.Window.change_workspace()`. The polling source is removed
on success, timeout, launch failure, or extension disable.

## Foreground program restoration

The `resume-foreground-processes` preference is disabled by default. When it is
enabled, `KittyClient` places `--use-foreground-process` before the destination
in the `save_as_session` action. This requires Kitty shell integration. The
`auto-run-commands` string array defaults to `codex` and is managed from the
preferences window.

`src/lib/sessionFile.js` parses Kitty's shell-quoted serialized launch payloads
without executing them. A command is retained only when its executable basename
or exact path matches the allowlist; otherwise the serialized startup command
is removed so Kitty opens its configured shell. For allowed interactive Codex
commands, a valid `kitty_session_restorer_codex_thread_id` produces `codex resume
<thread-id>`, including launches with options, resume commands, and forks.
`src/lib/codexCommand.js` separates option values from positional arguments,
preserves supported configuration options, and removes the original prompt,
attachments, `--worktree`, and session selection flags. The saved window UUID
overrides any old resume ID or `--last`. Unknown options and non-interactive
subcommands are left unchanged. Without a valid UUID, new-session commands open
the picker and explicit resume/fork commands keep their captured selection.
Snapshot processing happens before the inactive slot is published, so a file
error cannot replace the last complete snapshot.

## Exact Codex thread integration

Codex `SessionStart` and `SessionEnd` hooks receive the current `session_id`.
The start hook has no matcher, so it also tracks fork and compact events. See
the official [hook event documentation](https://learn.chatgpt.com/docs/hooks#sessionstart)
and [resume reference](https://developers.openai.com/codex/cli/reference#codex-resume).
Processes inside a Kitty window inherit `KITTY_WINDOW_ID`. The packaged
`lib/codexSessionHook.js` combines those identifiers. On start it invokes:

```text
kitten @ set-user-vars --match id:<window-id> \
  kitty_session_restorer_codex_thread_id=<thread-id>
```

Kitty serializes that user variable as part of the matching launch entry. The
end hook unsets the variable only if it still contains the ending thread's
UUID, preventing stale or racing sessions from clearing newer metadata. Both
paths validate the identifiers, use argument arrays, and never read the Codex
transcript.

`src/lib/codexHookInstaller.js` powers **Install Hooks** in extension
preferences. It parses the existing `~/.codex/hooks.json`, removes only earlier
copies of this extension's two hook commands, appends the current definitions,
and atomically writes a private file. Unrelated properties, events, groups, and
commands are preserved. Invalid JSON is reported without changing the file.

After upgrading from hooks with a `startup|resume|clear` matcher, use **Update
Hooks** to capture forks as well. After installation, Codex must be restarted
and the user must review and trust the hook through `/hooks`. Existing Codex
processes must be restarted or resumed once after setup.
`examples/codex-hooks.json` remains the manual setup reference.

The hook finds `kitten` on Codex's `PATH`. For a custom executable, prefix the
example command with:

```text
env KITTY_SESSION_RESTORER_KITTEN_COMMAND=/absolute/path/to/kitten gjs -m ...
```
