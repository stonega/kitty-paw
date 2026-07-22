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
- Keep the manifest backward compatible or introduce a versioned migration.
- Never change the user's Kitty configuration from extension code.
