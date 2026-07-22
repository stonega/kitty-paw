# User guide

## What is saved

The extension saves all detected Kitty processes. Each saved process can contain
multiple OS windows, tabs, splits, layouts, titles, and working directories.
Foreground programs started from an interactive shell are deliberately not
restarted. Scrollback, unsaved editor contents, shell variables, and command
history that has not been written by the shell are not captured.

## Restore a session

1. Close every Kitty window.
2. Click the paw in the GNOME top panel.
3. Wait for the saved Kitty windows to appear.

If Kitty is already open, the click is blocked and a notification explains why.
If no successful snapshot exists yet, the extension also reports that instead
of opening an empty terminal.

## Preferences

Open Extensions, select **Kitty Session Restorer**, and open Preferences. You
can change:

- The autosave interval, from 5 to 300 seconds.
- The Kitty and Kitten executable names or absolute paths.
- The remote-control socket template.
- Comma-separated application IDs and WM_CLASS values used to identify Kitty.

The defaults match Kitty installed on PATH with `listen_on unix:/tmp/kitty`.

## Troubleshooting

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

```text
unix:/tmp/kitty-{pid}
```

For `listen_on unix:${XDG_RUNTIME_DIR}/kitty-{kitty_pid}`, use
`unix:{runtimeDir}/kitty-{pid}`.

### Kitty is not detected

Custom `--class` or `--app-id` options change the identifier GNOME reports. Add
the custom value to **Window identifiers** in Preferences.

### The latest seconds were not saved

Closing the final window can remove Kitty's remote-control socket before the
extension's lifecycle save finishes. The periodic snapshot remains valid, so
the possible staleness is bounded by the configured autosave interval.
