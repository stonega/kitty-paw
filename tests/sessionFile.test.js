import { describe, expect, test } from 'bun:test';
import { CODEX_THREAD_VARIABLE } from '../src/lib/codexSession.js';
import { isAutoRunCommandAllowed, prepareSavedSession } from '../src/lib/sessionFile.js';

const threadId = '019c0123-4567-789a-bcde-f0123456789a';

function session(command) {
  const payload = `kitty-unserialize-data=${JSON.stringify({ id: 7, cmd_at_shell_startup: command })}`;
  return `launch '${payload.replaceAll("'", `'"'"'`)}' --var=${CODEX_THREAD_VARIABLE}=${threadId}`;
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
