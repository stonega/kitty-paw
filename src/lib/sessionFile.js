import { resumeCodexCommand } from './codexCommand.js';
import { CODEX_THREAD_VARIABLE, isCodexThreadId } from './codexSession.js';

const SERIALIZED_LAUNCH_PREFIX = 'kitty-unserialize-data=';
const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const CODEX_THREAD_VARIABLE_PREFIX = `--var=${CODEX_THREAD_VARIABLE}=`;

function parseShellWords(text, simpleCommand = false) {
  const words = [];
  let current = '';
  let started = false;
  let state = 'plain';

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (state === 'single') {
      if (character === "'") state = 'plain';
      else current += character;
      continue;
    }
    if (state === 'double') {
      if (character === '"') state = 'plain';
      else if (character === '\\' && index + 1 < text.length) {
        const next = text[index + 1];
        if (!simpleCommand || '\\"$`\n'.includes(next)) {
          index += 1;
          if (!simpleCommand || next !== '\n') current += next;
        } else current += character;
      } else if (simpleCommand && '$`!'.includes(character)) {
        throw new Error('Shell expansion cannot be restored as an argument array.');
      } else current += character;
      continue;
    }

    if (simpleCommand && /[|&;<>()`$*?[\]{}~#!\n\r]/.test(character))
      throw new Error('Only a simple foreground command can be restored.');
    if ((simpleCommand ? /[ \t]/ : /\s/).test(character)) {
      if (started) {
        words.push(current);
        current = '';
        started = false;
      }
    } else if (character === "'") {
      state = 'single';
      started = true;
    } else if (character === '"') {
      state = 'double';
      started = true;
    } else if (character === '\\' && index + 1 < text.length) {
      index += 1;
      if (!simpleCommand || text[index] !== '\n') {
        current += text[index];
        started = true;
      }
    } else if (simpleCommand && character === '\\') {
      throw new Error('Incomplete shell escape.');
    } else {
      current += character;
      started = true;
    }
  }

  if (state !== 'plain') throw new Error('Unterminated quoted session argument.');
  if (started) words.push(current);
  return words;
}

function foregroundCommandArgv(command) {
  try {
    const words = typeof command === 'string' ? parseShellWords(command, true) : command;
    return Array.isArray(words) &&
      words.length > 0 &&
      words.every((word) => typeof word === 'string' && !word.includes('\0'))
      ? words
      : null;
  } catch {
    return null;
  }
}

function quoteShellWord(word) {
  if (word && SAFE_SHELL_WORD.test(word)) return word;
  return `'${word.replaceAll("'", `'"'"'`)}'`;
}

export function normalizeAutoRunCommands(commands) {
  if (!Array.isArray(commands)) return [];
  return [
    ...new Set(
      commands
        .filter((command) => typeof command === 'string')
        .map((command) => command.trim())
        .filter((command) => command.length > 0 && !command.includes('\0')),
    ),
  ];
}

export function isAutoRunCommandAllowed(command, allowedCommands) {
  const words = foregroundCommandArgv(command);
  if (words === null || words[0].length === 0) return false;

  const executable = words[0];
  const executableName = executable.split('/').at(-1);
  return normalizeAutoRunCommands(allowedCommands).some((allowed) =>
    allowed.includes('/') ? executable === allowed : executableName === allowed,
  );
}

function savedCodexThreadId(words, command, window) {
  const variable = words.find((word) => word.startsWith(CODEX_THREAD_VARIABLE_PREFIX));
  const threadId = variable?.slice(CODEX_THREAD_VARIABLE_PREFIX.length);
  if (isCodexThreadId(threadId)) return threadId;

  // The hook can finish after Kitty serialized the session. Only use the later
  // listing when the same shell command is still running in this exact pane.
  const liveThreadId = window?.user_vars?.[CODEX_THREAD_VARIABLE];
  return matchesForegroundCommand(command, window) && isCodexThreadId(liveThreadId)
    ? liveThreadId
    : null;
}

function foregroundWindowsById(windows) {
  const byId = new Map();
  for (const osWindow of Array.isArray(windows) ? windows : []) {
    for (const tab of Array.isArray(osWindow?.tabs) ? osWindow.tabs : []) {
      for (const window of Array.isArray(tab?.windows) ? tab.windows : []) {
        if (!Number.isSafeInteger(window?.id) || window.id <= 0) continue;
        byId.set(window.id, byId.has(window.id) ? null : window);
      }
    }
  }
  return byId;
}

function matchesForegroundCommand(command, window) {
  return (
    command !== null &&
    window?.at_prompt === false &&
    JSON.stringify(foregroundCommandArgv(window.last_reported_cmdline)) === JSON.stringify(command)
  );
}

function resolveForegroundAlias(command, window, allowedCommands) {
  if (command === null || isAutoRunCommandAllowed(command, allowedCommands)) return command;
  // Never evaluate aliases or substitute a process from another pane or job.
  if (!matchesForegroundCommand(command, window)) return command;

  const candidates = (Array.isArray(window.foreground_processes) ? window.foreground_processes : [])
    .map((process) => process?.cmdline)
    .filter((argv) => Array.isArray(argv) && isAutoRunCommandAllowed(argv, allowedCommands));
  return candidates.length === 1 ? candidates[0] : command;
}

function rewriteLaunch(line, allowedCommands, enforceAllowlist, foregroundWindows = new Map()) {
  const match = /^(\s*launch)\s+(.+)$/.exec(line);
  if (!match) return line;

  let words;
  try {
    words = parseShellWords(match[2]);
  } catch (error) {
    if (enforceAllowlist)
      throw new Error(`Could not parse a saved Kitty launch entry: ${error.message}`);
    return line;
  }

  const serializedIndex = words.findIndex((word) => word.startsWith(SERIALIZED_LAUNCH_PREFIX));
  if (serializedIndex < 0) return line;

  try {
    const serialized = JSON.parse(words[serializedIndex].slice(SERIALIZED_LAUNCH_PREFIX.length));
    const originalCommand = serialized.cmd_at_shell_startup;
    const capturedCommand = foregroundCommandArgv(originalCommand);
    const window = foregroundWindows.get(serialized.id);
    const command = resolveForegroundAlias(capturedCommand, window, allowedCommands);
    if (enforceAllowlist && !isAutoRunCommandAllowed(command, allowedCommands)) {
      if (!Object.hasOwn(serialized, 'cmd_at_shell_startup')) return line;
      delete serialized.cmd_at_shell_startup;
    } else {
      const resumed = resumeCodexCommand(
        command,
        savedCodexThreadId(words, capturedCommand, window),
      );
      if (resumed === command && (!enforceAllowlist || command === originalCommand)) return line;
      if (resumed === null) delete serialized.cmd_at_shell_startup;
      else serialized.cmd_at_shell_startup = resumed;
    }
    words[serializedIndex] = `${SERIALIZED_LAUNCH_PREFIX}${JSON.stringify(serialized)}`;
    return `${match[1]} ${words.map(quoteShellWord).join(' ')}`;
  } catch (error) {
    if (enforceAllowlist)
      throw new Error(`Could not sanitize a saved Kitty launch entry: ${error.message}`);
    return line;
  }
}

export function resumeCodexThreads(sessionContents) {
  return sessionContents
    .split('\n')
    .map((line) => rewriteLaunch(line, ['codex'], false))
    .join('\n');
}

export function prepareSavedSession(sessionContents, allowedCommands, windows = []) {
  const normalizedCommands = normalizeAutoRunCommands(allowedCommands);
  const foregroundWindows = foregroundWindowsById(windows);
  return sessionContents
    .split('\n')
    .map((line) => rewriteLaunch(line, normalizedCommands, true, foregroundWindows))
    .join('\n');
}
