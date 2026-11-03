import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
  codexHookStatus,
  defaultCodexDirectory,
  installCodexHooks,
} from '../../src/lib/codexHookInstaller.js';
import { CODEX_HOOK_COMMAND } from '../../src/lib/codexHooks.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function runCodexConfigTests(temporaryDirectory) {
  const previousHome = GLib.getenv('CODEX_HOME');
  const codexHome = GLib.build_filenamev([temporaryDirectory, 'custom codex home']);
  try {
    GLib.setenv('CODEX_HOME', codexHome, true);
    assert(defaultCodexDirectory() === codexHome, 'The installer ignored CODEX_HOME.');
    assert(
      installCodexHooks() === GLib.build_filenamev([codexHome, 'hooks.json']),
      'Hooks were not installed into CODEX_HOME.',
    );
    assert(codexHookStatus().configured, 'Hook status did not use CODEX_HOME.');
    GLib.unsetenv('CODEX_HOME');
    assert(
      defaultCodexDirectory() === GLib.build_filenamev([GLib.get_home_dir(), '.codex']),
      'The default Codex directory changed.',
    );
  } finally {
    if (previousHome === null) GLib.unsetenv('CODEX_HOME');
    else GLib.setenv('CODEX_HOME', previousHome, true);
  }

  const binaryDirectory = GLib.build_filenamev([temporaryDirectory, 'hook-bin']);
  GLib.mkdir_with_parents(binaryDirectory, 0o700);
  const fakeGjs = GLib.build_filenamev([binaryDirectory, 'gjs']);
  GLib.file_set_contents(fakeGjs, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  GLib.chmod(fakeGjs, 0o700);
  const home = GLib.build_filenamev([temporaryDirectory, 'test home']);
  const dataHome = GLib.build_filenamev([temporaryDirectory, 'custom data']);
  for (const configured of [dataHome, '']) {
    const launcher = new Gio.SubprocessLauncher({
      flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    launcher.setenv('HOME', home, true);
    launcher.setenv('XDG_DATA_HOME', configured, true);
    launcher.setenv('PATH', `${binaryDirectory}:/usr/bin:/bin`, true);
    const process = launcher.spawnv(['/bin/sh', '-c', CODEX_HOOK_COMMAND]);
    const [stdout, stderr] = await process.communicate_utf8_async(null, null);
    assert(process.get_successful(), `The configured hook command failed: ${stderr}`);
    const expected = GLib.build_filenamev([
      configured || `${home}/.local/share`,
      'gnome-shell/extensions/kitty-session-restorer@stone.dev/lib/codexSessionHook.js',
    ]);
    assert(stdout === `-m\n${expected}\n`, 'The hook command ignored the data directory.');
  }
}
