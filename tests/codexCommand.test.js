import { describe, expect, test } from 'bun:test';
import { resumeCodexCommand } from '../src/lib/codexCommand.js';

const threadId = '019c0123-4567-789a-bcde-f0123456789a';
const oldThreadId = '019c9876-5432-7fed-ba98-76543210fedc';

describe('Codex recovery commands', () => {
  test.each([
    ['codex'],
    ['codex', '--model', 'my-model', '--profile', 'work'],
    ['/opt/bin/codex', '-c', 'model_reasoning_effort="high"', '--no-alt-screen'],
    ['codex', '-mmy-model', '--profile=work', '-cmodel_reasoning_effort="high"'],
    ['codex', '--cd', '/project with spaces', '--add-dir=/other/project', '--search'],
    ['codex', '--remote', 'unix:///tmp/codex.sock', '--no-daemon'],
  ])('resumes the saved thread while retaining options: %j', (...command) => {
    const expected = [command[0], 'resume', threadId, ...command.slice(1)];
    expect(resumeCodexCommand(command, threadId)).toEqual(expected);
    expect(resumeCodexCommand(expected, threadId)).toBe(expected);
  });

  test.each([
    ['codex', 'resume'],
    ['codex', 'resume', '--last', '--all', '--include-non-interactive'],
    ['codex', 'resume', oldThreadId],
    ['codex', 'resume', 'named-thread'],
    ['codex', 'fork', oldThreadId],
    ['codex', 'fork', '--last'],
  ])('pins a picker, resumed, switched, or forked thread: %j', (...command) => {
    expect(resumeCodexCommand(command, threadId)).toEqual(['codex', 'resume', threadId]);
  });

  test('retains options before and after the subcommand without replaying a prompt', () => {
    expect(
      resumeCodexCommand(
        ['codex', '-p', 'work', 'resume', '--model=my-model', oldThreadId, 'deploy again'],
        threadId,
      ),
    ).toEqual(['codex', 'resume', threadId, '-p', 'work', '--model=my-model']);
  });

  test('does not replay the original prompt, attachments, or worktree creation', () => {
    expect(
      resumeCodexCommand(
        ['codex', '--worktree', '--image', 'design.png', '--model', 'my-model', 'build this'],
        threadId,
      ),
    ).toEqual(['codex', 'resume', threadId, '--model', 'my-model']);
    expect(resumeCodexCommand(['codex', '-idesign.png', '--', '--help'], threadId)).toEqual([
      'codex',
      'resume',
      threadId,
    ]);
  });

  test('removes multiple image arguments while retaining following options', () => {
    expect(
      resumeCodexCommand(
        ['codex', 'build this', '--image', 'one.png', 'two.png', 'three.png', '-p', 'work'],
        threadId,
      ),
    ).toEqual(['codex', 'resume', threadId, '-p', 'work']);
    expect(
      resumeCodexCommand(
        ['codex', 'resume', oldThreadId, '--image=one.png', 'two.png', '--', 'follow up'],
        threadId,
      ),
    ).toEqual(['codex', 'resume', threadId]);
  });

  test.each([null, undefined, '', '--last', 'invalid-uuid'])(
    'uses the picker for a new session without a valid saved UUID: %j',
    (invalidId) => {
      expect(resumeCodexCommand(['codex', '-m', 'my-model', 'original prompt'], invalidId)).toEqual(
        ['codex', 'resume', '-m', 'my-model'],
      );
    },
  );

  test('preserves explicit session selection when no hook metadata is available', () => {
    for (const command of [
      ['codex', 'resume', oldThreadId],
      ['codex', 'resume', '--last'],
      ['codex', 'fork', oldThreadId],
    ])
      expect(resumeCodexCommand(command, null)).toBe(command);
  });

  test.each([
    ['codex', 'exec', 'deploy'],
    ['codex', '-m', 'my-model', 'e', 'deploy'],
    ['codex', 'review'],
    ['codex', 'login'],
    ['codex', '--help'],
    ['codex', 'resume', '--help'],
    ['codex', '--version'],
    ['codex', '--future-option', 'value'],
    ['codex', '--model'],
    ['codex', 'too', 'many', 'positionals'],
    ['codex', '--model', 42],
    ['nvim', 'file.txt'],
    ['my-codex-wrapper'],
    [],
  ])('preserves other, unsupported, or malformed commands: %j', (...command) => {
    expect(resumeCodexCommand(command, threadId)).toBe(command);
  });
});
