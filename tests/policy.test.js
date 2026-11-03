import { describe, expect, test } from 'bun:test';
import {
  CODEX_HOOK_COMMAND,
  hasConfiguredCodexHooks,
  mergeCodexHooksConfig,
} from '../src/lib/codexHooks.js';
import {
  CODEX_THREAD_VARIABLE,
  codexSessionEventFromHookInput,
  codexThreadIdFromHookInput,
  isCodexThreadId,
} from '../src/lib/codexSession.js';
import {
  chooseInactiveSlot,
  collectKittyInstances,
  collectKittyPids,
  expandSocketTemplate,
  matchesKittyWindow,
  normalizeIdentifier,
  restoreDecision,
  validateManifest,
} from '../src/lib/policy.js';
import {
  isAutoRunCommandAllowed,
  normalizeAutoRunCommands,
  prepareSavedSession,
  resumeCodexThreads,
} from '../src/lib/sessionFile.js';

describe('window policy', () => {
  test('normalizes and matches all supported identifiers', () => {
    expect(normalizeIdentifier('  Kitty.Desktop ')).toBe('kitty.desktop');
    expect(
      matchesKittyWindow({ appId: 'kitty.desktop', wmClass: '', wmClassInstance: '' }, [
        'kitty.desktop',
      ]),
    ).toBe(true);
    expect(
      matchesKittyWindow({ appId: 'window:1', wmClass: 'kitty', wmClassInstance: '' }, ['KITTY']),
    ).toBe(true);
  });

  test('deduplicates and sorts Kitty process IDs', () => {
    const windows = [
      { appId: 'kitty.desktop', pid: 44 },
      { appId: 'other.desktop', pid: 1 },
      { pid: 12, wmClass: 'kitty' },
      { appId: 'kitty.desktop', pid: 44 },
      { appId: 'kitty.desktop', pid: -1 },
    ];
    expect(collectKittyPids(windows, ['kitty', 'kitty.desktop'])).toEqual([12, 44]);
  });

  test('collects workspaces in stable window creation order', () => {
    const windows = [
      {
        appId: 'kitty.desktop',
        pid: 44,
        stableSequence: 20,
        workspaceIndex: 3,
      },
      {
        appId: 'kitty.desktop',
        pid: 12,
        stableSequence: 30,
        workspaceIndex: -1,
      },
      {
        appId: 'kitty.desktop',
        pid: 44,
        stableSequence: 10,
        workspaceIndex: 1,
      },
    ];

    expect(collectKittyInstances(windows, ['kitty.desktop'])).toEqual([
      { pid: 12, workspaces: [null] },
      { pid: 44, workspaces: [1, 3] },
    ]);
  });
});

describe('socket policy', () => {
  test('expands supported placeholders', () => {
    expect(
      expandSocketTemplate('unix:{runtimeDir}/kitty-{uid}-{pid}', 812, {
        runtimeDir: '/run/user/1000',
        uid: '1000',
      }),
    ).toBe('unix:/run/user/1000/kitty-1000-812');
  });

  test('rejects unsafe or unusable templates', () => {
    expect(() => expandSocketTemplate('/tmp/kitty-{pid}', 1)).toThrow('unix: or tcp:');
    expect(() => expandSocketTemplate('unix:/tmp/kitty', 1)).toThrow('{pid}');
    expect(() => expandSocketTemplate('unix:/tmp/kitty-{pid}', 0)).toThrow('positive integer');
  });
});

describe('snapshot policy', () => {
  const manifest = {
    instances: [
      { file: 'instance-001.session', pid: 12, workspaces: [null] },
      { file: 'instance-002.session', pid: 44, workspaces: [1, 3] },
    ],
    reason: 'periodic',
    savedAt: '2026-07-22T12:00:00.000Z',
    version: 1,
  };

  test('validates the versioned manifest', () => {
    expect(validateManifest(manifest)).toBe(true);
    expect(validateManifest({ ...manifest, version: 2 })).toBe(false);
    expect(
      validateManifest({
        ...manifest,
        instances: [{ file: '../escape.session', pid: 12 }],
      }),
    ).toBe(false);
    expect(
      validateManifest({
        ...manifest,
        instances: [
          { file: 'instance-001.session', pid: 12 },
          { file: 'instance-001.session', pid: 44 },
        ],
      }),
    ).toBe(false);
    expect(
      validateManifest({
        ...manifest,
        instances: [{ file: 'instance-001.session', pid: 12, workspaces: [-1] }],
      }),
    ).toBe(false);
    expect(
      validateManifest({
        ...manifest,
        instances: [{ file: 'instance-001.session', pid: 12, workspaces: [] }],
      }),
    ).toBe(false);
    expect(
      validateManifest({
        ...manifest,
        instances: [{ file: 'instance-001.session', pid: 12 }],
      }),
    ).toBe(true);
  });

  test('alternates slots and computes restore decisions', () => {
    expect(chooseInactiveSlot(null)).toBe('slot-a');
    expect(chooseInactiveSlot('slot-a')).toBe('slot-b');
    expect(restoreDecision({ hasKittyWindows: true, hasSnapshot: true, isRestoring: false })).toBe(
      'kitty-open',
    );
    expect(
      restoreDecision({ hasKittyWindows: false, hasSnapshot: false, isRestoring: false }),
    ).toBe('no-snapshot');
    expect(restoreDecision({ hasKittyWindows: false, hasSnapshot: true, isRestoring: true })).toBe(
      'busy',
    );
    expect(restoreDecision({ hasKittyWindows: false, hasSnapshot: true, isRestoring: false })).toBe(
      'ready',
    );
  });
});

describe('saved foreground commands', () => {
  const firstThreadId = '019c0123-4567-789a-bcde-f0123456789a';
  const secondThreadId = '019c9876-5432-7fed-ba98-76543210fedc';

  test('resumes the exact Codex thread saved for each Kitty window', () => {
    const session = [
      `launch 'kitty-unserialize-data={"id":4,"cmd_at_shell_startup":["/usr/bin/codex"]}' --var=${CODEX_THREAD_VARIABLE}=${firstThreadId}`,
      `launch 'kitty-unserialize-data={"id":5,"cmd_at_shell_startup":["codex"]}' --var=${CODEX_THREAD_VARIABLE}=${secondThreadId}`,
      '',
    ].join('\n');

    const resumed = resumeCodexThreads(session);
    expect(resumed).toContain(
      `"cmd_at_shell_startup":["/usr/bin/codex","resume","${firstThreadId}"]`,
    );
    expect(resumed).toContain(`"cmd_at_shell_startup":["codex","resume","${secondThreadId}"]`);
    expect(resumeCodexThreads(resumed)).toBe(resumed);
  });

  test('opens the Codex resume picker when exact thread metadata is unavailable', () => {
    const session =
      'launch \'kitty-unserialize-data={"id":4,"cmd_at_shell_startup":["/usr/bin/codex"]}\'\n';
    expect(resumeCodexThreads(session)).toBe(
      'launch \'kitty-unserialize-data={"id":4,"cmd_at_shell_startup":["/usr/bin/codex","resume"]}\'\n',
    );
  });

  test('leaves other and explicitly configured commands unchanged', () => {
    const neovim =
      'launch \'kitty-unserialize-data={"id":4,"cmd_at_shell_startup":["nvim","it\'"\'"\'s.txt"]}\'';
    const explicitCodex =
      'launch \'kitty-unserialize-data={"id":5,"cmd_at_shell_startup":["codex","resume","thread-id"]}\'';

    expect(resumeCodexThreads(neovim)).toBe(neovim);
    expect(resumeCodexThreads(explicitCodex)).toBe(explicitCodex);
  });

  test('pins configured and resumed commands to each window UUID before publishing', () => {
    const session = [
      `launch 'kitty-unserialize-data={"id":4,"cmd_at_shell_startup":["/usr/bin/codex","--profile","work","build it"]}' --var=${CODEX_THREAD_VARIABLE}=${firstThreadId}`,
      `launch 'kitty-unserialize-data={"id":5,"cmd_at_shell_startup":["codex","resume","--last"]}' --var=${CODEX_THREAD_VARIABLE}=${secondThreadId}`,
    ].join('\n');
    const prepared = prepareSavedSession(session, ['codex']);
    expect(prepared).toContain(
      `"cmd_at_shell_startup":["/usr/bin/codex","resume","${firstThreadId}","--profile","work"]`,
    );
    expect(prepared).toContain(`"cmd_at_shell_startup":["codex","resume","${secondThreadId}"]`);
    expect(prepared).not.toContain('build it');
    expect(prepared).not.toContain('--last');
    expect(prepareSavedSession(prepared, ['codex'])).toBe(prepared);
    expect(prepareSavedSession(session, [])).not.toContain('cmd_at_shell_startup');
  });

  test('does not use malformed window metadata as a resume argument', () => {
    const session = `launch 'kitty-unserialize-data={"cmd_at_shell_startup":["codex","--model=my-model"]}' --var=${CODEX_THREAD_VARIABLE}=--last`;
    expect(prepareSavedSession(session, ['codex'])).toContain(
      '"cmd_at_shell_startup":["codex","resume","--model=my-model"]',
    );
  });

  test('keeps only foreground commands in the auto-run allowlist', () => {
    const session = [
      'launch \'kitty-unserialize-data={"id":4,"cmd_at_shell_startup":["/usr/bin/nvim","notes.md"]}\'',
      'launch \'kitty-unserialize-data={"id":5,"cmd_at_shell_startup":["make","deploy"]}\'',
      'launch \'kitty-unserialize-data={"id":6,"cmd_at_shell_startup":["/opt/tools/task"]}\'',
    ].join('\n');

    const prepared = prepareSavedSession(session, ['nvim', '/opt/tools/task']);
    expect(prepared).toContain('"cmd_at_shell_startup":["/usr/bin/nvim","notes.md"]');
    expect(prepared).toContain('kitty-unserialize-data={"id":5}');
    expect(prepared).not.toContain('"make","deploy"');
    expect(prepared).toContain('"cmd_at_shell_startup":["/opt/tools/task"]');
  });

  test('normalizes allowlist entries and matches names or exact paths', () => {
    expect(normalizeAutoRunCommands([' codex ', '', 'codex', null, 'nvim'])).toEqual([
      'codex',
      'nvim',
    ]);
    expect(isAutoRunCommandAllowed(['/usr/bin/codex'], ['codex'])).toBe(true);
    expect(isAutoRunCommandAllowed(['/usr/bin/codex'], ['/usr/bin/codex'])).toBe(true);
    expect(isAutoRunCommandAllowed(['/usr/local/bin/codex'], ['/usr/bin/codex'])).toBe(false);
    expect(isAutoRunCommandAllowed(['make', 'deploy'], ['codex'])).toBe(false);
  });

  test('rejects malformed serialized commands instead of publishing them unsanitized', () => {
    expect(() =>
      prepareSavedSession("launch 'kitty-unserialize-data={invalid}'", ['codex']),
    ).toThrow('Could not sanitize');
    expect(() =>
      prepareSavedSession('launch \'kitty-unserialize-data={"id":4}', ['codex']),
    ).toThrow('Could not parse');
  });
});

describe('Codex session hook metadata', () => {
  const threadId = '019c0123-4567-789a-bcde-f0123456789a';

  test('accepts only a SessionStart payload with a UUID thread id', () => {
    expect(
      codexThreadIdFromHookInput(
        JSON.stringify({
          hook_event_name: 'SessionStart',
          session_id: threadId,
        }),
      ),
    ).toBe(threadId);
    expect(
      codexThreadIdFromHookInput(
        JSON.stringify({
          hook_event_name: 'SessionEnd',
          session_id: threadId,
        }),
      ),
    ).toBeNull();
    expect(
      codexSessionEventFromHookInput(
        JSON.stringify({
          hook_event_name: 'SessionEnd',
          session_id: threadId,
        }),
      ),
    ).toEqual({ name: 'SessionEnd', threadId });
    expect(codexThreadIdFromHookInput('{invalid')).toBeNull();
    expect(isCodexThreadId('--last')).toBe(false);
  });
});

describe('Codex hooks configuration', () => {
  test('merges managed hooks without replacing unrelated hooks', () => {
    const existingHook = {
      command: '/usr/bin/notify-existing-hook',
      type: 'command',
    };
    const merged = mergeCodexHooksConfig({
      custom: true,
      hooks: {
        SessionStart: [{ hooks: [existingHook], matcher: 'startup' }],
        UserPromptSubmit: [{ hooks: [existingHook] }],
      },
    });

    expect(merged.custom).toBe(true);
    expect(merged.hooks.SessionStart[0].hooks[0]).toEqual(existingHook);
    expect(merged.hooks.UserPromptSubmit[0].hooks[0]).toEqual(existingHook);
    expect(hasConfiguredCodexHooks(merged)).toBe(true);
    expect(merged.hooks.SessionStart.at(-1).hooks[0].command).toBe(CODEX_HOOK_COMMAND);
  });

  test('updates managed entries idempotently', () => {
    const once = mergeCodexHooksConfig({});
    const twice = mergeCodexHooksConfig(once);

    expect(twice).toEqual(once);
    expect(
      twice.hooks.SessionStart.flatMap((group) => group.hooks).filter(
        (hook) => hook.command === CODEX_HOOK_COMMAND,
      ),
    ).toHaveLength(1);
  });

  test('upgrades start hooks to track every source, including fork and compact', () => {
    const previous = mergeCodexHooksConfig({});
    previous.hooks.SessionStart[0].matcher = 'startup|resume|clear';
    const updated = mergeCodexHooksConfig(previous);
    expect(updated.hooks.SessionStart).toHaveLength(1);
    expect(updated.hooks.SessionStart[0].matcher).toBeUndefined();
  });

  test('keeps the manual hook example in sync with the installer', async () => {
    const example = await Bun.file(new URL('../examples/codex-hooks.json', import.meta.url)).json();
    expect(example).toEqual(mergeCodexHooksConfig({}));
  });

  test('rejects malformed hooks collections', () => {
    expect(() => mergeCodexHooksConfig({ hooks: [] })).toThrow('must be an object');
    expect(() => mergeCodexHooksConfig({ hooks: { SessionStart: {} } })).toThrow(
      'must be an array',
    );
  });
});
