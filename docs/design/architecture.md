# Architecture

## Components

The GNOME Shell entry point owns a panel button and a `SessionController`. The
controller coordinates three narrow services:

- `KittyWindowTracker` identifies Kitty windows through GNOME's application ID,
  WM_CLASS, and process metadata.
- `KittyClient` invokes Kitty and Kitten through asynchronous `Gio.Subprocess`
  argument arrays. No shell interprets settings or paths.
- `SnapshotStore` maintains private, versioned state below
  `$XDG_STATE_HOME/kitty-session-restorer`.

Pure matching, manifest, socket-template, and restore policy lives in
`src/lib/policy.js` so it can be tested without GNOME Shell.

## Save flow

GNOME window creation, Kitty window destruction, focus changes, extension
startup, and a periodic timer request saves. Requests are debounced and only
one save may execute at a time. Internal Kitty changes such as a new tab or
working-directory change are caught by the periodic timer because GNOME does
not receive those events.

The tracker returns one PID per Kitty process. For every process, Kitten invokes
the global `save_as_session --save-only` action over its remote-control socket.
Each process produces one session file containing all of its OS windows.

## Atomic snapshot state

State alternates between `slot-a` and `slot-b`. A capture always writes the
inactive slot, validates every non-empty session file, and writes a versioned
manifest before atomically replacing the small `current` pointer file. If any
process exits, times out, or writes invalid output, the incomplete slot is
removed and the pointer continues to reference the last complete snapshot.

The manifest format is:

```json
{
  "version": 1,
  "savedAt": "2026-07-22T12:00:00.000Z",
  "reason": "periodic",
  "instances": [{ "pid": 12345, "file": "instance-001.session" }]
}
```

Stored PIDs are diagnostic metadata only. They are never trusted or reused
during restore.

## Restore flow

A click checks current GNOME windows and blocks restore if Kitty is already
open. With a valid snapshot, the controller launches one detached Kitty process
per saved instance using `kitty --detach --session <file>`. A restore is guarded
against repeated clicks. Partial launch failures are reported and never alter
the saved snapshot.

## Lifecycle and failure handling

Disabling the extension removes timers and signal handlers, cancels pending
subprocess communication, terminates child processes started by the extension,
and destroys the panel actor. Save failures are logged and rate-limited in the
desktop notification UI. The paw turns red after an error and returns to its
normal panel color after a successful operation.
