export const CODEX_HOOK_COMMAND =
  'gjs -m "$HOME/.local/share/gnome-shell/extensions/kitty-session-restorer@stone.dev/lib/codexSessionHook.js"';

const MANAGED_HOOK_PATH = '/kitty-session-restorer@stone.dev/lib/codexSessionHook.js';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isManagedHook(hook) {
  return (
    isObject(hook) &&
    hook.type === 'command' &&
    typeof hook.command === 'string' &&
    hook.command.includes(MANAGED_HOOK_PATH)
  );
}

function withoutManagedHooks(groups) {
  if (!Array.isArray(groups)) throw new Error('Codex hook event entries must be an array.');

  return groups.flatMap((group) => {
    if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
    const hooks = group.hooks.filter((hook) => !isManagedHook(hook));
    return hooks.length > 0 ? [{ ...group, hooks }] : [];
  });
}

function commandHook(statusMessage) {
  return {
    command: CODEX_HOOK_COMMAND,
    statusMessage,
    timeout: 3,
    type: 'command',
  };
}

export function configuredCodexHooks() {
  return {
    SessionEnd: [
      {
        hooks: [commandHook('Clearing this Codex thread from its Kitty tab')],
      },
    ],
    SessionStart: [
      {
        hooks: [commandHook('Linking this Codex thread to its Kitty tab')],
      },
    ],
  };
}

export function mergeCodexHooksConfig(config) {
  if (!isObject(config)) throw new Error('Codex hooks.json must contain a JSON object.');
  if (config.hooks !== undefined && !isObject(config.hooks))
    throw new Error('The hooks property in Codex hooks.json must be an object.');

  const hooks = { ...(config.hooks ?? {}) };
  const configured = configuredCodexHooks();
  for (const eventName of ['SessionStart', 'SessionEnd']) {
    hooks[eventName] = [...withoutManagedHooks(hooks[eventName] ?? []), ...configured[eventName]];
  }

  return {
    ...config,
    ...(config.description === undefined
      ? {
          description:
            'Record the active Codex thread on its Kitty window for exact session restoration.',
        }
      : {}),
    hooks,
  };
}

export function hasConfiguredCodexHooks(config) {
  if (!isObject(config) || !isObject(config.hooks)) return false;
  return ['SessionStart', 'SessionEnd'].every((eventName) =>
    Array.isArray(config.hooks[eventName])
      ? config.hooks[eventName].some(
          (group) =>
            isObject(group) &&
            Array.isArray(group.hooks) &&
            group.hooks.some((hook) => isManagedHook(hook)),
        )
      : false,
  );
}
