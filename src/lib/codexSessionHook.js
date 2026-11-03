import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import { hasLocalCodexClient } from './codexCommand.js';
import { CODEX_THREAD_VARIABLE, codexSessionEventFromHookInput } from './codexSession.js';

const WINDOW_ID_PATTERN = /^[1-9][0-9]*$/;

function readProcessFile(path) {
  const stream = Gio.File.new_for_path(path).read(null);
  try {
    const contents = stream.read_bytes(16 * 1024 + 1, null).get_data();
    if (contents.length > 16 * 1024) throw new Error('Process metadata is too large.');
    return new TextDecoder().decode(contents);
  } finally {
    stream.close(null);
  }
}

function* ancestorCommands() {
  let pid = 'self';
  const seen = new Set();
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      const stat = readProcessFile(`/proc/${pid}/stat`);
      const parent = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
      if (!WINDOW_ID_PATTERN.test(parent) || seen.has(parent)) return;
      seen.add(parent);
      const command = readProcessFile(`/proc/${parent}/cmdline`).split('\0');
      if (command.at(-1) === '') command.pop();
      yield command;
      pid = parent;
    } catch {
      return;
    }
  }
}

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
  if (!hasLocalCodexClient(ancestorCommands()))
    throw new Error(
      'Exact Kitty thread tracking requires a local interactive Codex process. Start Codex with --no-daemon; shared or remote app servers cannot identify the calling Kitty window.',
    );

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
