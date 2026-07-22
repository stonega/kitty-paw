# Kitty Session Restorer

Kitty Session Restorer is a GNOME Shell 50 extension that continuously saves
Kitty window layouts and restores the latest complete snapshot from a paw icon
in the top panel. Restore is intentionally blocked while any Kitty window is
open.

The extension preserves Kitty OS windows, tabs, splits, layouts, shell working
directories, and explicit window launch commands. It does not restart a
foreground program that was launched from an interactive shell.

## Requirements

- GNOME Shell 50
- Kitty and Kitten 0.48 or newer
- Kitty remote control over a Unix socket
- Bun for development commands

## Kitty setup

Add these lines to `~/.config/kitty/kitty.conf`, then close and reopen every
Kitty process:

```conf
allow_remote_control socket-only
listen_on unix:/tmp/kitty
```

Kitty appends its process ID to that address, producing sockets such as
`unix:/tmp/kitty-12345`. This matches the extension's default
`unix:/tmp/kitty-{pid}` template. See [examples/kitty.conf](examples/kitty.conf)
for the runtime-directory alternative.

## Install locally

```bash
bun install
bun run install:local
```

If GNOME does not load the newly installed extension immediately, log out and
back in, then run:

```bash
gnome-extensions enable kitty-session-restorer@stone.dev
```

Open Kitty and allow at most 30 seconds for the first periodic snapshot. After
closing every Kitty window, click the paw in the top panel to restore it.

## Development

```bash
bun run check
bun run package
bun run smoke
```

The package is written to
`dist/kitty-session-restorer@stone.dev.shell-extension.zip`. Runtime code has no
JavaScript package dependencies; Bun and Biome are development tools only.

See [architecture](docs/design/architecture.md), [developer setup](docs/implementation/setup.md),
and the [user guide](docs/user/guide.md) for details.

## License

Extension code is licensed under GPL-3.0-or-later. The supplied paw icon is
from Font Awesome Solid by Dave Gandy and is licensed under CC BY 4.0; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
