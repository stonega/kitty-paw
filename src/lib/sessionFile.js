import { CODEX_THREAD_VARIABLE, isCodexThreadId } from './codexSession.js';

const SERIALIZED_LAUNCH_PREFIX = 'kitty-unserialize-data=';
const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const CODEX_THREAD_VARIABLE_PREFIX = `--var=${CODEX_THREAD_VARIABLE}=`;

function parseShellWords(text) {
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
        index += 1;
        current += text[index];
      } else current += character;
      continue;
    }

    if (/\s/.test(character)) {
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
      current += text[index];
      started = true;
    } else {
      current += character;
      started = true;
    }
  }

  if (state !== 'plain') throw new Error('Unterminated quoted session argument.');
  if (started) words.push(current);
  return words;
}

function quoteShellWord(word) {
  if (word && SAFE_SHELL_WORD.test(word)) return word;
  return `'${word.replaceAll("'", `'"'"'`)}'`;
}

function isBareCodexCommand(command) {
  if (!Array.isArray(command) || command.length !== 1 || typeof command[0] !== 'string')
    return false;
  const executable = command[0].split('/').at(-1);
  return executable === 'codex';
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
  if (!Array.isArray(command) || typeof command[0] !== 'string' || command[0].length === 0)
    return false;

  const executable = command[0];
  const executableName = executable.split('/').at(-1);
  return normalizeAutoRunCommands(allowedCommands).some((allowed) =>
    allowed.includes('/') ? executable === allowed : executableName === allowed,
  );
}

function savedCodexThreadId(words) {
  const variable = words.find((word) => word.startsWith(CODEX_THREAD_VARIABLE_PREFIX));
  if (!variable) return null;
  const threadId = variable.slice(CODEX_THREAD_VARIABLE_PREFIX.length);
  return isCodexThreadId(threadId) ? threadId : null;
}

function rewriteLaunch(line, allowedCommands, enforceAllowlist) {
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
    const command = serialized.cmd_at_shell_startup;
    if (enforceAllowlist && !isAutoRunCommandAllowed(command, allowedCommands)) {
      if (!Object.hasOwn(serialized, 'cmd_at_shell_startup')) return line;
      delete serialized.cmd_at_shell_startup;
    } else if (isBareCodexCommand(command)) {
      command.push('resume');
      const threadId = savedCodexThreadId(words);
      if (threadId !== null) command.push(threadId);
    } else {
      return line;
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

export function prepareSavedSession(sessionContents, allowedCommands) {
  const normalizedCommands = normalizeAutoRunCommands(allowedCommands);
  return sessionContents
    .split('\n')
    .map((line) => rewriteLaunch(line, normalizedCommands, true))
    .join('\n');
}
