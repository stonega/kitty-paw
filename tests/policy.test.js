import { describe, expect, test } from 'bun:test';

import {
  chooseInactiveSlot,
  collectKittyPids,
  expandSocketTemplate,
  matchesKittyWindow,
  normalizeIdentifier,
  restoreDecision,
  validateManifest,
} from '../src/lib/policy.js';

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
      { file: 'instance-001.session', pid: 12 },
      { file: 'instance-002.session', pid: 44 },
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
