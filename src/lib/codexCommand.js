import { isCodexThreadId } from './codexSession.js';

// Keep option values separate from positional session IDs and prompts. Unknown
// options leave the captured command intact rather than guessing their arity.
const VALUE_OPTIONS = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '-m',
  '--model',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '-a',
  '--ask-for-approval',
  '-C',
  '--cd',
  '--add-dir',
  '--local-provider',
  '--remote',
  '--remote-auth-token-env',
]);
const FLAG_OPTIONS = new Set([
  '--oss',
  '--approve-for-me',
  '--full-auto',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--dangerously-bypass-hook-trust',
  '--search',
  '--no-alt-screen',
  '--no-daemon',
  '--strict-config',
]);
const SELECTION_OPTIONS = new Set(['--last', '--all', '--include-non-interactive']);
const NON_INTERACTIVE_COMMANDS = new Set([
  'agents',
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'plugin',
  'app-server',
  'remote-control',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'apply',
  'a',
  'queue',
  'archive',
  'delete',
  'migrate-rollouts',
  'migrate-nfs-db',
  'unarchive',
  'cloud',
  'exec-server',
  'features',
  'help',
]);

function interactiveOptions(args) {
  const options = [];
  let mode = null;
  let positionals = 0;
  let literal = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!literal && argument === '--') {
      literal = true;
      continue;
    }
    if (!literal && argument.startsWith('-')) {
      const option = argument.startsWith('--')
        ? argument.split('=', 1)[0]
        : /^-[cmpsaCi].+/.test(argument)
          ? argument.slice(0, 2)
          : argument;
      const hasValue = option !== argument;
      if (option === '-i' || option === '--image') {
        // --image accepts multiple consecutive file arguments. The original
        // attachments (and any trailing prompt) already belong to the thread.
        // An attached value (--image=file or -ifile) ends that option's values.
        if (!hasValue) {
          if (++index >= args.length || args[index].startsWith('-')) return null;
          while (index + 1 < args.length && !args[index + 1].startsWith('-')) index += 1;
        }
      } else if (VALUE_OPTIONS.has(option)) {
        if (!hasValue && (++index >= args.length || args[index].startsWith('-'))) return null;
        options.push(argument);
        if (!hasValue) options.push(args[index]);
      } else if (FLAG_OPTIONS.has(argument)) {
        options.push(argument);
      } else if (argument === '--worktree' || (mode && SELECTION_OPTIONS.has(argument))) {
        // Recovery reuses a thread; it must not create a worktree or select
        // whichever session happens to be latest at restore time.
      } else {
        return null;
      }
      continue;
    }

    if (!literal && mode === null && positionals === 0) {
      if (argument === 'resume' || argument === 'fork') {
        mode = argument;
        continue;
      }
      if (NON_INTERACTIVE_COMMANDS.has(argument)) return null;
    }
    positionals += 1;
    if (positionals > (mode ? 2 : 1)) return null;
  }

  return { mode, options };
}

function parsedCodexCommand(command) {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((word) => typeof word === 'string') ||
    command[0].split('/').at(-1) !== 'codex'
  )
    return null;

  return interactiveOptions(command.slice(1));
}

export function hasLocalCodexClient(ancestorCommands) {
  for (const command of ancestorCommands) {
    if (command[0]?.split('/').at(-1) === 'codex')
      // Stop at the nearest Codex process: nested execs and app servers must
      // not overwrite an outer interactive client's Kitty metadata.
      return parsedCodexCommand(command) !== null;
  }
  return false;
}

export function resumeCodexCommand(command, threadId) {
  const parsed = parsedCodexCommand(command);
  const exactThread = isCodexThreadId(threadId);
  if (parsed === null || (parsed.mode !== null && !exactThread)) return command;

  const resumed = [command[0], 'resume', ...(exactThread ? [threadId] : []), ...parsed.options];
  return JSON.stringify(resumed) === JSON.stringify(command) ? command : resumed;
}
