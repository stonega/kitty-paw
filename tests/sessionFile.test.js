import { describe, expect, test } from 'bun:test';
import { CODEX_THREAD_VARIABLE } from '../src/lib/codexSession.js';
import { isAutoRunCommandAllowed, prepareSavedSession } from '../src/lib/sessionFile.js';

const threadId = '019c0123-4567-789a-bcde-f0123456789a';

function session(command, savedThreadId = threadId) {
  const payload = `kitty-unserialize-data=${JSON.stringify({ id: 7, cmd_at_shell_startup: command })}`;
  const variable = savedThreadId === null ? '' : ` --var=${CODEX_THREAD_VARIABLE}=${savedThreadId}`;
  return `launch '${payload.replaceAll("'", `'"'"'`)}'${variable}`;
}

describe('Kitty shell integration command strings', () => {
  test('restores actual string payloads as exact Codex resume argument arrays', () => {
    expect(
      prepareSavedSession(session('codex --no-daemon --profile work "original prompt"'), ['codex']),
    ).toBe(session(['codex', 'resume', threadId, '--no-daemon', '--profile', 'work']));
    expect(prepareSavedSession(session('codex resume --last'), ['codex'])).toBe(
      session(['codex', 'resume', threadId]),
    );
    const continued = ['codex \\', '--no-daemon'].join('\n');
    expect(prepareSavedSession(session(continued), ['codex'])).toBe(
      session(['codex', 'resume', threadId, '--no-daemon']),
    );
  });

  test('preserves literal quoted arguments while removing shell evaluation', () => {
    for (const [command, expected] of [
      ['nvim "notes with spaces.txt"', ['nvim', 'notes with spaces.txt']],
      ["nvim 'it\"s $HOME.txt'", ['nvim', 'it"s $HOME.txt']],
      ['nvim "a\\q.txt"', ['nvim', 'a\\q.txt']],
      ['nvim "\\$HOME.txt"', ['nvim', '$HOME.txt']],
      ['nvim "*.txt"', ['nvim', '*.txt']],
      ["'/opt/my tools/nvim' notes.txt", ['/opt/my tools/nvim', 'notes.txt']],
    ])
      expect(prepareSavedSession(session(command), ['nvim'])).toBe(session(expected));
  });

  test.each(
    [
      'codex; touch marker',
      'codex && touch marker',
      'codex | nvim',
      'codex > log.txt',
      'codex $(touch marker)',
      'codex `touch marker`',
      'codex "$HOME"',
      'codex\ntouch marker',
      'codex # comment',
      'nvim *.txt',
      'nvim ~/notes.txt',
      'codex "unterminated',
      'codex \\',
      ['codex', null],
      ['codex', '\0'],
    ].map((command) => [command]),
  )('opens a shell for compound, expanding, or malformed commands: %j', (command) => {
    expect(prepareSavedSession(session(command), ['codex', 'nvim'])).toBe(session(undefined));
  });

  test('applies the allowlist to string commands as well as arrays', () => {
    expect(isAutoRunCommandAllowed('codex --no-daemon', ['codex'])).toBe(true);
    expect(isAutoRunCommandAllowed('/opt/codex --no-daemon', ['/usr/bin/codex'])).toBe(false);
    expect(prepareSavedSession(session('codex --no-daemon'), [])).toBe(session(undefined));
  });
});

function foregroundWindows(overrides = {}) {
  return [
    {
      id: 1,
      tabs: [
        {
          windows: [
            {
              id: 7,
              at_prompt: false,
              last_reported_cmdline: 'ac',
              foreground_processes: [
                { cmdline: ['codex', '-a', 'never', '-s', 'danger-full-access', '--no-daemon'] },
                { cmdline: ['sleep', 'infinity'] },
              ],
              ...overrides,
            },
          ],
        },
      ],
    },
  ];
}

describe('foreground programs started through shell aliases', () => {
  test('resolves ac to the actual Codex argv and resumes the saved thread', () => {
    expect(prepareSavedSession(session('ac'), ['codex'], foregroundWindows())).toBe(
      session([
        'codex',
        'resume',
        threadId,
        '-a',
        'never',
        '-s',
        'danger-full-access',
        '--no-daemon',
      ]),
    );
  });

  test('reopens a shell when the alias has no thread metadata', () => {
    expect(prepareSavedSession(session('ac', null), ['codex'], foregroundWindows())).toBe(
      session(undefined, null),
    );
  });

  test.each([
    { id: 8 },
    { at_prompt: true },
    { at_prompt: undefined },
    { last_reported_cmdline: 'different-job' },
    { foreground_processes: [{ cmdline: ['nvim', 'file.txt'] }] },
    { foreground_processes: [{ cmdline: ['codex'] }, { cmdline: ['codex', '--no-daemon'] }] },
    { foreground_processes: [{ cmdline: 'codex' }] },
    { foreground_processes: [{ cmdline: ['codex', null] }] },
    { foreground_processes: null },
  ])('rejects mismatched, idle, unallowed, or ambiguous foreground data: %j', (overrides) => {
    expect(prepareSavedSession(session('ac'), ['codex'], foregroundWindows(overrides))).toBe(
      session(undefined),
    );
  });

  test('does not resolve unsafe shell syntax or override the executable allowlist', () => {
    for (const command of ['ac && deploy', 'ac "$HOME"', undefined]) {
      expect(
        prepareSavedSession(
          session(command),
          ['codex'],
          foregroundWindows({ last_reported_cmdline: command }),
        ),
      ).toBe(session(undefined));
    }
    expect(prepareSavedSession(session('ac'), [], foregroundWindows())).toBe(session(undefined));
    expect(prepareSavedSession(session('ac'), ['/opt/codex'], foregroundWindows())).toBe(
      session(undefined),
    );
  });

  test('keeps process and thread matching local to each terminal ID', () => {
    const otherThread = '019c9876-5432-7fed-ba98-76543210fedc';
    const other = (contents) =>
      contents.replace('"id":7', '"id":8').replaceAll(threadId, otherThread);
    const windows = foregroundWindows();
    windows[0].tabs[0].windows.unshift({
      id: 8,
      at_prompt: false,
      last_reported_cmdline: 'ac',
      foreground_processes: [{ cmdline: ['/opt/codex', '--profile', 'other'] }],
    });
    expect(
      prepareSavedSession(`${session('ac')}\n${other(session('ac'))}`, ['codex'], windows),
    ).toBe(
      `${session(['codex', 'resume', threadId, '-a', 'never', '-s', 'danger-full-access', '--no-daemon'])}\n${other(session(['/opt/codex', 'resume', threadId, '--profile', 'other']))}`,
    );
  });

  test('rejects duplicate terminal IDs', () => {
    expect(
      prepareSavedSession(
        session('ac'),
        ['codex'],
        [...foregroundWindows(), ...foregroundWindows()],
      ),
    ).toBe(session(undefined));
  });
});

describe('exact Codex thread metadata from the foreground listing', () => {
  test.each(['ac', 'codex --no-daemon'])(
    'uses the matching pane UUID when serialization missed the hook: %s',
    (command) => {
      const windows = foregroundWindows({
        last_reported_cmdline: command,
        user_vars: { [CODEX_THREAD_VARIABLE]: threadId },
      });
      const prepared = prepareSavedSession(session(command, null), ['codex'], windows);
      expect(prepared).toContain(`"cmd_at_shell_startup":["codex","resume","${threadId}"`);
      expect(prepareSavedSession(prepared, ['codex'], windows)).toBe(prepared);
    },
  );

  test('keeps the captured UUID ahead of later window metadata', () => {
    const windows = foregroundWindows({
      user_vars: { [CODEX_THREAD_VARIABLE]: '019c9876-5432-7fed-ba98-76543210fedc' },
    });
    expect(prepareSavedSession(session('ac'), ['codex'], windows)).toContain(
      `"cmd_at_shell_startup":["codex","resume","${threadId}"`,
    );
  });

  test.each([
    { id: 8 },
    { at_prompt: true },
    { at_prompt: undefined },
    { last_reported_cmdline: 'another-job' },
    { user_vars: { [CODEX_THREAD_VARIABLE]: '--last' } },
    { user_vars: null },
  ])('rejects mismatched or malformed pane metadata: %j', (overrides) => {
    const windows = foregroundWindows({
      last_reported_cmdline: 'codex',
      user_vars: { [CODEX_THREAD_VARIABLE]: threadId },
      ...overrides,
    });
    expect(prepareSavedSession(session('codex', null), ['codex'], windows)).toBe(
      session(undefined, null),
    );
  });

  test('does not borrow a thread from a duplicate pane ID', () => {
    const windows = foregroundWindows({
      last_reported_cmdline: 'codex',
      user_vars: { [CODEX_THREAD_VARIABLE]: threadId },
    });
    expect(prepareSavedSession(session('codex', null), ['codex'], [...windows, ...windows])).toBe(
      session(undefined, null),
    );
  });

  test('binds two panes in the same directory to their own UUIDs', () => {
    const otherThreadId = '019c9876-5432-7fed-ba98-76543210fedc';
    const windows = foregroundWindows({
      cwd: '/project',
      last_reported_cmdline: 'codex',
      user_vars: { [CODEX_THREAD_VARIABLE]: threadId },
    });
    windows[0].tabs[0].windows.push({
      id: 8,
      cwd: '/project',
      at_prompt: false,
      last_reported_cmdline: 'codex',
      user_vars: { [CODEX_THREAD_VARIABLE]: otherThreadId },
    });
    const input = session('codex', null);
    expect(
      prepareSavedSession(`${input}\n${input.replace('"id":7', '"id":8')}`, ['codex'], windows),
    ).toBe(
      `${session(['codex', 'resume', threadId], null)}\n${session(['codex', 'resume', otherThreadId], null).replace('"id":7', '"id":8')}`,
    );
  });
});
