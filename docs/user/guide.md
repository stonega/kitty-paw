# User guide

## What is saved

The extension saves all detected Kitty processes. Each saved process can contain
multiple OS windows, tabs, splits, layouts, titles, and working directories.
Each Kitty OS window's GNOME workspace is also saved.
Foreground programs started from an interactive shell are not restarted by
default. Enable **Restart allowed foreground programs** to have Kitty capture
their command lines. Only executables in **Auto-run command allowlist** are
retained for relaunch; other windows reopen with a normal shell. This requires
Kitty shell integration.

With that option enabled, a command such as `nvim file.txt` is launched again
in the saved working directory. With the Codex hook configured, a bare `codex`
command becomes `codex resume <thread-id>`. Each Kitty window records its own
thread, so several Codex tabs in the same project restore independently. If
exact metadata is unavailable, the tab opens `codex resume` and shows the
picker instead of guessing with `--last`.

This restores commands, not in-memory application state. Unsaved editor
buffers, scrollback, shell variables, and command history that has not been
written by the shell are not captured.

## Restore a session

1. Close every Kitty window.
2. Click the paw in the GNOME top panel.
3. Wait for the saved Kitty windows to appear.

Each window is moved back to its saved GNOME workspace. The extension creates a
missing workspace when necessary but does not switch away from the workspace
where you clicked restore. Snapshots made by an older extension version still
restore, but do not gain workspace placement until Kitty is saved again.

If Kitty is already open, the click is blocked and a notification explains why.
If no successful snapshot exists yet, the extension also reports that instead
of opening an empty terminal.

## Preferences

Open Extensions, select **Kitty Session Restorer**, and open Preferences. You
can change:

- The autosave interval, from 5 to 300 seconds.
- Whether allowlisted foreground programs should be restarted.
- Executable names or exact paths in the auto-run command allowlist.
- Codex CLI hook installation and current configuration status.

The defaults match Kitty installed on PATH with `listen_on unix:/tmp/kitty`.
Advanced compatibility overrides remain available through GSettings for
nonstandard installations.

> [!WARNING]
> Foreground restoration re-runs allowlisted commands with their saved
> arguments. Add interactive programs deliberately, and do not allow commands
> whose side effects would be unsafe to repeat.

## Enable exact Codex thread restore

1. Open the extension preferences and find **Codex CLI integration**.
2. Click **Install Hooks**. Existing hooks and other configuration are
   preserved.
3. Restart Codex, run `/hooks`, review the command, and trust it.
4. Restart or resume each Codex thread that was already open before setup.
5. Keep `codex` in **Auto-run command allowlist** and enable
   **Restart allowed foreground programs**.

The hook records only the current Codex thread UUID as Kitty window metadata.
It does not read or copy the conversation transcript. New snapshots then bind
each Kitty window to its exact thread.

If the preferences installer reports invalid JSON, repair
`~/.codex/hooks.json` and try again. For manual setup, merge the event entries
from `examples/codex-hooks.json` without replacing unrelated hooks.

## Troubleshooting

### Autosave appears to stall the desktop

Snapshot disk operations run asynchronously so slow storage does not block
GNOME Shell. Only one capture runs at a time, and timer ticks during a running
capture do not queue another save. Each Kitty command has a 10-second timeout;
multiple Kitty processes are saved in sequence. If saving fails, the previous
complete snapshot remains available. Follow the Shell logs described in the
developer setup document to identify timeouts or remote-control errors.

### The paw turns red

A save or restore command failed. Confirm that `kitty` and `kitten` are visible
to GNOME Shell and that Kitty was restarted after enabling remote control.
Follow the logs described in the developer setup document for the exact error.
The last successful snapshot remains available.

### The extension cannot find the socket

Kitty appends its PID to `listen_on` unless the configuration contains
`{kitty_pid}`. For this configuration:

```conf
listen_on unix:/tmp/kitty
```

use this extension template:

```bash
gsettings set org.gnome.shell.extensions.kitty-session-restorer \
  socket-template 'unix:/tmp/kitty-{pid}'
```

For `listen_on unix:${XDG_RUNTIME_DIR}/kitty-{kitty_pid}`, use
`unix:{runtimeDir}/kitty-{pid}`:

```bash
gsettings set org.gnome.shell.extensions.kitty-session-restorer \
  socket-template 'unix:{runtimeDir}/kitty-{pid}'
```

### Kitty is not detected

Custom `--class` or `--app-id` options change the identifier GNOME reports.
Append the custom value to the hidden compatibility setting:

```bash
gsettings set org.gnome.shell.extensions.kitty-session-restorer \
  kitty-window-identifiers "['kitty', 'kitty.desktop', 'custom-identifier']"
```

### Kitty or Kitten is not on GNOME Shell's PATH

Set absolute executable paths through the hidden compatibility settings:

```bash
gsettings set org.gnome.shell.extensions.kitty-session-restorer \
  kitty-command '/absolute/path/to/kitty'
gsettings set org.gnome.shell.extensions.kitty-session-restorer \
  kitten-command '/absolute/path/to/kitten'
```

### The latest seconds were not saved

Closing the final window can remove Kitty's remote-control socket before the
extension's lifecycle save finishes. The periodic snapshot remains valid, so
the possible staleness is bounded by the configured autosave interval.
