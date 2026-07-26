import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import { CODEX_THREAD_VARIABLE, codexSessionEventFromHookInput } from './codexSession.js';

const WINDOW_ID_PATTERN = /^[1-9][0-9]*$/;

function readStandardInput() {
  const [ok, contents] = GLib.file_get_contents('/dev/stdin');
  if (!ok) throw new Error('Could not read the Codex hook payload.');
  return new TextDecoder().decode(contents);
}

function run() {
  const windowId = GLib.getenv('KITTY_WINDOW_ID') ?? '';
  if (!WINDOW_ID_PATTERN.test(windowId)) return;

  const event = codexSessionEventFromHookInput(readStandardInput());
  if (event === null) return;

  const kittenCommand = GLib.getenv('KITTY_SESSION_RESTORER_KITTEN_COMMAND')?.trim() || 'kitten';
  const match =
    event.name === 'SessionStart'
      ? `id:${windowId}`
      : `id:${windowId} and var:${CODEX_THREAD_VARIABLE}=${event.threadId}`;
  const variable =
    event.name === 'SessionStart'
      ? `${CODEX_THREAD_VARIABLE}=${event.threadId}`
      : CODEX_THREAD_VARIABLE;
  const process = Gio.Subprocess.new(
    [kittenCommand, '@', 'set-user-vars', '--match', match, variable],
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
  );
  const [, stderr] = process.communicate_utf8(null, null);
  if (!process.get_successful()) {
    const status = process.get_exit_status();
    throw new Error(stderr.trim() || `${kittenCommand} exited with status ${status}.`);
  }
}

try {
  run();
} catch (error) {
  printerr(`Kitty Session Restorer Codex hook failed: ${error.message ?? String(error)}`);
  System.exit(1);
}
