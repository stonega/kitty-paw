# Kitty Session Restorer

Kitty Session Restorer is a GNOME Shell 50 extension that continuously saves
Kitty window layouts. Click the paw icon in the top panel to list and switch to
open Kitty windows, or choose **Restore** when no Kitty windows are open to
recover the latest complete snapshot.

The extension preserves Kitty OS windows, their GNOME workspace placement,
tabs, splits, layouts, shell working directories, and explicit window launch
commands. An opt-in preference can also restart foreground programs such as
Neovim. With the supplied Codex hooks configured, interactive Codex commands
restore as `codex resume <thread-id>`, including commands with common options,
resumed chats, and forks. Multiple tabs in the same project continue their own
chats without replaying their original prompts.

## Requirements

- GNOME Shell 50
- Kitty and Kitten 0.48 or newer
- Kitty remote control over a Unix socket
- Kitty shell integration when foreground-program restoration is enabled
- A trusted Codex `SessionStart` hook for exact per-tab Codex restoration
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
closing every Kitty window, click the paw in the top panel and choose **Restore**.

## Foreground command allowlist

Open the extension preferences:

```bash
gnome-extensions prefs kitty-session-restorer@stone.dev
```

Enable **Restart allowed foreground programs**, then add each executable that
may be relaunched to **Auto-run command allowlist**. An entry such as `nvim`
matches that executable at any path; `/usr/bin/nvim` allows only that exact
path. `codex` is included by default. Commands not on the list reopen as a
normal shell, even though Kitty captured their command lines.

## Exact Codex thread restore

1. Open the extension preferences and find **Codex CLI integration**.
2. Click **Install Hooks** (or **Update Hooks** after upgrading). This merges
   the extension's `SessionStart` and `SessionEnd` hooks into `~/.codex/hooks.json`.
3. Restart Codex, run `/hooks`, review the command, and trust it.
4. Start or resume each thread with `codex --no-daemon` (for example,
   `codex --no-daemon resume <thread-id>`). This gives the hooks that tab's
   environment instead of a shared app server's environment.
5. Keep `codex` in the auto-run allowlist and enable foreground restoration.

For manual setup, merge the entries from
[examples/codex-hooks.json](examples/codex-hooks.json) into
`~/.codex/hooks.json`; do not replace unrelated hooks.

The hook stores only the Codex thread UUID as private Kitty window metadata,
and each snapshot saves it with that window's recovery command. Model, profile,
and other supported options are retained. Without a valid UUID, new-session
commands open the resume picker; explicit `resume` and `fork` commands retain
their captured selection. See the [user guide](docs/user/guide.md) for details.

Custom installations use `$CODEX_HOME/hooks.json` and `$XDG_DATA_HOME` for the
installed extension, with the usual `~/.codex` and `~/.local/share` defaults.

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
from Firefox OS Emoji by Mozilla and is licensed under CC BY 4.0; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
