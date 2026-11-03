import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { SETTINGS_KEYS } from '../../src/lib/constants.js';
import { SessionController } from '../../src/lib/sessionController.js';
import { SnapshotStore } from '../../src/lib/snapshotStore.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function writeText(path, text) {
  await Gio.File.new_for_path(path).replace_contents_bytes_async(
    new GLib.Bytes(new TextEncoder().encode(text)),
    null,
    false,
    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
    null,
  );
}

async function expectCancellation(operation) {
  let cancelled = false;
  try {
    await operation;
  } catch (error) {
    cancelled = error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
  }
  assert(cancelled, 'Expected snapshot IO to propagate cancellation.');
}

async function testSnapshotIO(baseDirectory) {
  const store = new SnapshotStore({ baseDirectory });
  assert((await store.loadCurrent()) === null, 'An empty store should have no snapshot.');
  const capture = (reason, extra = {}) =>
    store.capture({
      captureInstance: (_pid, path) => writeText(path, 'launch original\n'),
      instances: [{ pid: 1 }],
      processSession: (contents) => contents.replace('original', 'processed'),
      reason,
      ...extra,
    });

  const first = await capture('first');
  const [contents] = await Gio.File.new_for_path(first.sessionPaths[0]).load_contents_async(null);
  assert(new TextDecoder().decode(contents) === 'launch processed\n', 'Session transform failed.');
  for (const [path, mode] of [
    [baseDirectory, 0o700],
    [`${baseDirectory}/slot-a`, 0o700],
    [`${baseDirectory}/slot-a/manifest.json`, 0o600],
    [`${baseDirectory}/current`, 0o600],
    [first.sessionPaths[0], 0o600],
  ]) {
    const info = await Gio.File.new_for_path(path).query_info_async(
      'unix::mode',
      Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
      GLib.PRIORITY_DEFAULT,
      null,
    );
    assert((info.get_attribute_uint32('unix::mode') & 0o777) === mode, 'State is not private.');
  }

  // Exercise asynchronous recursive cleanup and more than one enumeration batch.
  for (const path of [`${baseDirectory}/slot-b`, `${baseDirectory}/slot-b/stale`])
    await Gio.File.new_for_path(path).make_directory_async(GLib.PRIORITY_DEFAULT, null);
  for (let index = 0; index < 35; index++)
    await writeText(`${baseDirectory}/slot-b/stale/${index}`, 'old');
  const second = await capture('second');
  assert(
    (await store.loadCurrent()).manifest.reason === 'second',
    'New snapshot was not published.',
  );

  let failed = false;
  try {
    await capture('invalid', { processSession: () => '' });
  } catch {
    failed = true;
  }
  assert(failed, 'An empty processed session was accepted.');
  assert((await store.loadCurrent()).manifest.reason === 'second', 'Failure replaced good state.');

  const cancelled = new Gio.Cancellable();
  await expectCancellation(
    capture('cancelled', {
      cancellable: cancelled,
      captureInstance: async (_pid, path) => {
        await writeText(path, 'launch incomplete\n');
        cancelled.cancel();
      },
    }),
  );
  assert(
    (await store.loadCurrent()).manifest.reason === 'second',
    'Cancellation published a snapshot.',
  );
  await expectCancellation(store.loadCurrent({ cancellable: cancelled }));
  await expectCancellation(
    capture('already-cancelled', {
      cancellable: cancelled,
      captureInstance: () => {
        throw new Error('A cancelled save must not start Kitty.');
      },
    }),
  );

  await capture('recovered');
  assert(
    (await store.loadCurrent()).manifest.reason === 'recovered',
    'Cancelled slot was not reused.',
  );
  await writeText(`${baseDirectory}/slot-a/manifest.json`, '{broken');
  assert(
    (await store.loadCurrent()).sessionPaths[0] === second.sessionPaths[0],
    'An invalid active slot did not fall back to the last complete snapshot.',
  );
}

async function testControllerScheduling() {
  const read = deferred();
  const finalRead = deferred();
  const saving = deferred();
  const saveStarted = deferred();
  let hasWindows = false;
  let reads = 0;
  let launches = 0;
  let captureCancellable;
  let readCancellable;
  const notifications = [];
  const statuses = [];
  const snapshot = {
    manifest: { instances: [{ pid: 1 }] },
    sessionPaths: ['/fake/session'],
  };
  const controller = new SessionController({
    client: {
      launchSession: async () => launches++,
      stop() {},
    },
    logger: { error() {} },
    notify: (_title, body) => notifications.push(body),
    onStatusChanged: (status) => statuses.push(status),
    settings: {
      connect: () => 1,
      disconnect() {},
      get_boolean: () => false,
      get_string: (key) => (key === SETTINGS_KEYS.socketTemplate ? 'unix:/fake-{pid}' : 'fake'),
      get_strv: () => [],
      get_uint: () => 300,
    },
    store: {
      capture: async ({ cancellable }) => {
        captureCancellable = cancellable;
        saveStarted.resolve();
        await saving.promise;
      },
      loadCurrent: ({ cancellable }) => {
        readCancellable = cancellable;
        reads++;
        return reads === 1 ? read.promise : finalRead.promise;
      },
    },
    tracker: {
      hasKittyWindows: () => hasWindows,
      kittyInstances: () => [{ pid: 1 }],
      start() {},
      stop() {},
    },
  });
  controller.start();
  try {
    const scheduled = controller._debounceId;
    for (let index = 0; index < 20; index++) controller.requestSave('focus-changed');
    assert(controller._debounceId === scheduled, 'Focus changes postponed the scheduled save.');

    const restore = controller.restore();
    await controller.restore();
    assert(reads === 1, 'Repeated clicks started overlapping snapshot reads.');
    assert(
      notifications.at(-1).includes('already being restored'),
      'Restore guard was not reported.',
    );
    hasWindows = true;
    read.resolve(snapshot);
    await restore;
    assert(launches === 0, 'Restore launched despite Kitty opening during snapshot IO.');

    hasWindows = false;
    const pendingRestore = controller.restore();
    const capture = controller._capture('test');
    await saveStarted.promise;
    for (let index = 0; index < 20; index++) controller.requestSave('periodic');
    assert(!controller._pendingSave, 'Periodic ticks queued a redundant follow-up capture.');
    controller.requestSave('window-created');
    assert(controller._pendingSave, 'Window events during a capture were lost.');
    controller.requestSave('periodic');
    assert(controller._pendingReason === 'window-created', 'A timer replaced the pending event.');
    controller.stop();
    assert(captureCancellable.is_cancelled(), 'Disable did not cancel snapshot writes.');
    assert(readCancellable.is_cancelled(), 'Disable did not cancel snapshot reads.');
    const statusCount = statuses.length;
    finalRead.resolve(snapshot);
    saving.resolve();
    await Promise.all([capture, pendingRestore]);
    assert(launches === 0, 'A snapshot read completed after disable and launched Kitty.');
    assert(statuses.length === statusCount, 'A disabled controller updated the panel.');
    assert(controller._debounceId === 0, 'Disable left a scheduled save behind.');
  } finally {
    controller.stop();
  }
}

export async function runPerformanceTests(temporaryDirectory) {
  // Fail on synchronous filesystem access even when the OS cache makes it look fast.
  const calls = [];
  const originals = [];
  for (const [object, methods] of [
    [GLib, ['file_get_contents', 'file_set_contents', 'mkdir_with_parents', 'chmod', 'rename']],
    [
      Gio.File.prototype,
      [
        'query_exists',
        'query_info',
        'enumerate_children',
        'delete',
        'load_contents',
        'replace_contents',
      ],
    ],
    [Gio.FileEnumerator.prototype, ['next_file', 'close']],
  ]) {
    for (const method of methods) {
      originals.push([object, method, object[method]]);
      object[method] = () => {
        calls.push(method);
        throw new Error(`Synchronous filesystem call during snapshot IO: ${method}`);
      };
    }
  }
  try {
    await testSnapshotIO(`${temporaryDirectory}/performance/nested/state`);
    await testControllerScheduling();
    assert(calls.length === 0, `Snapshot IO blocked the main loop: ${calls.join(', ')}`);
  } finally {
    for (const [object, method, original] of originals) object[method] = original;
  }
}
