import { describe, expect, test } from 'bun:test';

import { matchWindowTabDetails, WindowTabLoader } from '../src/lib/windowTabs.js';

const remoteWindow = (id, tabs) => ({
  id,
  tabs: Array.from({ length: tabs }, () => ({ windows: [{}, {}] })),
});
const window = (pid, stableSequence) => ({ metaWindow: {}, pid, stableSequence });

describe('window tab details', () => {
  test('matches OS windows by creation order and counts tabs, including split panes only once', () => {
    const first = window(42, 10);
    const second = window(42, 20);
    const windows = [second, first];
    const remote = [remoteWindow(8, 3), remoteWindow(2, 1)];
    const details = matchWindowTabDetails(windows, remote);
    expect(details.get(first.metaWindow)).toEqual({ directory: undefined, tabCount: 1 });
    expect(details.get(second.metaWindow)).toEqual({ directory: undefined, tabCount: 3 });
    expect(windows).toEqual([second, first]);
    expect(remote.map(({ id }) => id)).toEqual([8, 2]);
  });

  test('rejects incomplete, malformed, or ambiguous window sets', () => {
    const windows = [window(42, 1), window(42, 2)];
    for (const remote of [
      null,
      {},
      [remoteWindow(1, 2)],
      [remoteWindow(1, 2), null],
      [remoteWindow(1, 2), { id: 2 }],
      [remoteWindow(1, 2), remoteWindow(-1, 3)],
      [remoteWindow(1, 2), remoteWindow(1, 3)],
    ])
      expect(matchWindowTabDetails(windows, remote).size).toBe(0);
    for (const sequences of [
      [1, 1],
      [1, null],
    ])
      expect(
        matchWindowTabDetails(
          sequences.map((sequence) => window(42, sequence)),
          [remoteWindow(1, 1), remoteWindow(2, 2)],
        ).size,
      ).toBe(0);
  });

  test('uses the active pane in the active tab even when the OS window is unfocused', async () => {
    const first = window(42, 10);
    const second = window(42, 20);
    const remote = [
      {
        id: 8,
        tabs: [{ is_active: true, windows: [{ is_active: true, cwd: '/srv/second' }] }],
      },
      {
        id: 2,
        is_focused: false,
        tabs: [
          { is_active: false, windows: [{ is_active: true, cwd: '/inactive-tab' }] },
          {
            is_active: true,
            windows: [
              { is_active: false, cwd: '/inactive-pane' },
              { is_active: true, is_focused: false, cwd: '/home/stone/My Project/目錄' },
            ],
          },
        ],
      },
    ];
    let calls = 0;
    const loader = new WindowTabLoader({
      listWindows: async () => {
        calls++;
        return remote;
      },
    });
    const details = await loader.load([second, first]);
    expect(details.get(first.metaWindow)).toEqual({
      directory: '/home/stone/My Project/目錄',
      tabCount: 2,
    });
    expect(details.get(second.metaWindow)).toEqual({ directory: '/srv/second', tabCount: 1 });
    expect(calls).toBe(1);
    remote[1].tabs[1].windows[1].cwd = '/changed';
    expect((await loader.load([first, second])).get(first.metaWindow)?.directory).toBe('/changed');
    expect(calls).toBe(2);
  });

  test('supports a single tab and pane without active flags', () => {
    const current = window(42, 1);
    expect(
      matchWindowTabDetails([current], [{ id: 1, tabs: [{ windows: [{ cwd: '/' }] }] }]).get(
        current.metaWindow,
      ),
    ).toEqual({ directory: '/', tabCount: 1 });
  });

  test('keeps tab counts when the active directory is missing, malformed, or ambiguous', () => {
    const current = window(42, 1);
    for (const tabs of [
      [],
      [null],
      [{ windows: null }],
      [{ windows: [{}] }],
      ...[null, 42, {}, '', '  '].map((cwd) => [{ windows: [{ cwd }] }]),
      [{ windows: [{ cwd: '/one' }, { cwd: '/two' }] }],
      [
        {
          windows: [
            { is_active: true, cwd: '/one' },
            { is_active: true, cwd: '/two' },
          ],
        },
      ],
      [{ windows: [{ cwd: '/one' }] }, { windows: [{ cwd: '/two' }] }],
      [
        { is_active: true, windows: [{ cwd: '/one' }] },
        { is_active: true, windows: [{ cwd: '/two' }] },
      ],
      [
        { is_active: true, windows: [{}] },
        { is_active: false, windows: [{ cwd: '/inactive' }] },
      ],
    ])
      expect(matchWindowTabDetails([current], [{ id: 1, tabs }]).get(current.metaWindow)).toEqual({
        directory: undefined,
        tabCount: tabs.length,
      });
  });

  test('queries once per process and isolates failures and invalid PIDs', async () => {
    const windows = [window(42, 1), window(42, 2), window(43, 3), window(44, 4), window(-1, 5)];
    const calls = [];
    const counter = new WindowTabLoader({
      listWindows: async (pid) => {
        calls.push(pid);
        if (pid === 43) throw new Error('socket unavailable');
        return pid === 42 ? [remoteWindow(1, 2), remoteWindow(2, 4)] : [remoteWindow(1, 1)];
      },
    });
    const counts = await counter.load(windows);
    expect(calls).toEqual([42, 43, 44]);
    expect(windows.map(({ metaWindow }) => counts.get(metaWindow)?.tabCount)).toEqual([
      2,
      4,
      undefined,
      1,
      undefined,
    ]);
  });

  test('shares in-flight queries and refreshes on the next opening', async () => {
    let resolve;
    let calls = 0;
    const counter = new WindowTabLoader({
      listWindows: () => {
        calls++;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const windows = [window(42, 1)];
    const first = counter.load(windows);
    const second = counter.load(windows);
    await Promise.resolve();
    expect(calls).toBe(1);
    resolve([remoteWindow(1, 2)]);
    expect((await first).get(windows[0].metaWindow)?.tabCount).toBe(2);
    expect((await second).get(windows[0].metaWindow)?.tabCount).toBe(2);
    const refreshed = counter.load(windows);
    await Promise.resolve();
    expect(calls).toBe(2);
    resolve([remoteWindow(1, 3)]);
    expect((await refreshed).get(windows[0].metaWindow)?.tabCount).toBe(3);
  });

  test('stop discards pending results and prevents subsequent queries', async () => {
    let resolve;
    const calls = [];
    const counter = new WindowTabLoader({
      listWindows: (pid) => {
        calls.push(pid);
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const windows = [window(42, 1), window(43, 2)];
    const pending = counter.load(windows);
    await Promise.resolve();
    counter.stop();
    resolve([remoteWindow(1, 1)]);
    expect((await pending).size).toBe(0);
    expect((await counter.load(windows)).size).toBe(0);
    expect(calls).toEqual([42]);
  });

  test('stop before dispatch prevents a queued query from starting', async () => {
    let called = false;
    const counter = new WindowTabLoader({
      listWindows: () => {
        called = true;
        return [];
      },
    });
    const pending = counter.load([window(42, 1)]);
    counter.stop();
    expect((await pending).size).toBe(0);
    expect(called).toBe(false);
  });
});
