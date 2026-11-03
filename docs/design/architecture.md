# Architecture

## Components

The GNOME Shell entry point owns a panel button and a `SessionController`. The
controller coordinates three narrow services:

- `KittyWindowTracker` identifies Kitty windows through GNOME's application ID,
  WM_CLASS, and process metadata. It owns a `WorkspaceRestorer` that waits for
  newly launched windows and applies their saved Mutter workspaces.
- `KittyClient` invokes Kitty and Kitten through asynchronous `Gio.Subprocess`
  argument arrays. No shell interprets settings or paths.
- `SnapshotStore` maintains private, versioned state below
  `$XDG_STATE_HOME/kitty-session-restorer`.

Pure matching, manifest, socket-template, and restore policy lives in
`src/lib/policy.js` so it can be tested without GNOME Shell.

## Save flow

GNOME window creation, Kitty window destruction, focus changes, extension
startup, and a periodic timer request saves. Requests are debounced and only
one save may execute at a time. The first request sets a fixed debounce deadline;
later focus events do not postpone it. Periodic ticks during a running save are
absorbed by that save, while window and settings events request one follow-up.
Internal Kitty changes such as a new tab or
working-directory change are caught by the periodic timer because GNOME does
not receive those events.

The tracker returns one PID per Kitty process plus the GNOME workspace index of
each OS window, ordered by Mutter's stable window-creation sequence. For every
process, Kitten invokes the global `save_as_session --save-only` action over its
remote-control socket. Each process produces one session file containing all of
its OS windows.

When foreground-program restoration is enabled, the client adds Kitty's
`--use-foreground-process` option. Kitty then serializes the active command line
for windows that started as shells. Before publishing the snapshot, a pure
session-file transform removes `cmd_at_shell_startup` from every command not in
the `auto-run-commands` allowlist. Kitty consequently starts the configured
shell in that window instead of the captured program. Allowlist entries without
a slash match an executable basename at any path; entries containing a slash
match the exact path.

For allowed interactive Codex commands, the same transform emits `codex resume
<thread-id>` when exact thread metadata is available. This covers new sessions
with options or a prompt, resume pickers, `resume --last`, explicit resume IDs,
and forks. The window's current UUID takes precedence over the original command
because the user may have switched or forked threads since launch. A pure
argument parser preserves supported options while discarding the original
prompt, image attachments, worktree creation, and old session selectors.
Non-interactive subcommands and commands with unknown options are retained as
captured rather than rewritten using guessed option semantics.

Exact Codex matching uses user-configured Codex `SessionStart` and `SessionEnd`
hooks packaged with the extension. Codex supplies the current session UUID to
the hooks, and Kitty supplies `KITTY_WINDOW_ID`. The start hook writes the UUID
to that window as a namespaced Kitty user variable for every start source,
including fork and compaction. The end hook clears it only if the window still
holds the ending thread's UUID. Kitty's session
serializer preserves the variable on the matching `launch` entry, allowing the
pure transform to bind each window to its own thread even when several tabs
share a working directory. The hooks never read the transcript. When metadata
is absent or malformed, new-session commands become `codex resume` with their
supported options so Codex shows its picker. Explicit resume and fork commands
keep their captured selection when metadata is unavailable.

## Atomic snapshot state

State alternates between `slot-a` and `slot-b`. A capture always writes the
inactive slot, validates every non-empty session file, and writes a versioned
manifest before atomically replacing the small `current` pointer file. If any
process exits, times out, or writes invalid output, the incomplete slot is
removed and the pointer continues to reference the last complete snapshot.

Snapshot directory creation, cleanup, reads, validation, permission changes, and
atomic writes use asynchronous Gio operations so filesystem latency does not
block GNOME Shell. The controller shares a cancellable across snapshot reads
and writes and cancels it on disable. Cancelled captures leave incomplete files
in the inactive slot for the next capture to clean up, without publishing them.
Restore reserves its busy state before reading and rechecks for open Kitty
windows after the read completes.

The manifest format is:

```json
{
  "version": 1,
  "savedAt": "2026-07-22T12:00:00.000Z",
  "reason": "periodic",
  "instances": [
    {
      "pid": 12345,
      "file": "instance-001.session",
      "workspaces": [0, 2]
    }
  ]
}
```

Stored PIDs are diagnostic metadata only. They are never trusted or reused
during restore. `workspaces` is optional so snapshots created before workspace
capture was introduced remain valid. A `null` entry means GNOME did not expose
a usable workspace for that window when the snapshot was taken.

## Restore flow

A click checks current GNOME windows and blocks restore if Kitty is already
open. With a valid snapshot, the controller launches one detached Kitty process
per saved instance using `kitty --detach --session <file>`. The tracker waits a
bounded amount of time for that instance's OS windows, matches them in stable
creation order, creates missing GNOME workspaces when necessary, and moves each
window to its saved workspace without switching the user's active workspace.
Legacy snapshots without workspace metadata retain GNOME's default placement.
A restore is guarded against repeated clicks. Partial launch failures are
reported and never alter the saved snapshot.

Foreground-program capture is disabled by default because restoring a session
re-runs serialized commands. When enabled, only the user-managed allowlist may
restart. `codex` is the default entry; users can add interactive programs such
as editors, but should not allow commands whose external side effects are
unsafe to repeat.

## Lifecycle and failure handling

Disabling the extension removes timers and signal handlers, cancels pending
subprocess communication, terminates child processes started by the extension,
and destroys the panel actor. Save failures are logged and rate-limited in the
desktop notification UI. The paw turns red after an error and returns to its
normal panel color after a successful operation.
