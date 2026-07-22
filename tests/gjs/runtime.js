import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { KittyClient } from '../../src/lib/kittyClient.js';
import { SnapshotStore } from '../../src/lib/snapshotStore.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeExecutable(path, contents) {
  if (!GLib.file_set_contents(path, contents)) throw new Error(`Could not create ${path}`);
  GLib.chmod(path, 0o700);
}

function readText(path) {
  const [ok, contents] = GLib.file_get_contents(path);
  if (!ok) throw new Error(`Could not read ${path}`);
  return new TextDecoder().decode(contents);
}

function removeTree(path) {
  const file = Gio.File.new_for_path(path);
  if (!file.query_exists(null)) return;
  const info = file.query_info('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
  if (info.get_file_type() === Gio.FileType.DIRECTORY) {
    const children = file.enumerate_children(
      'standard::name',
      Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
      null,
    );
    try {
      for (let child = children.next_file(null); child; child = children.next_file(null))
        removeTree(file.get_child(child.get_name()).get_path());
    } finally {
      children.close(null);
    }
  }
  file.delete(null);
}

const temporaryDirectory = GLib.dir_make_tmp('kitty-session-restorer-test-XXXXXX');
const fakeKitten = GLib.build_filenamev([temporaryDirectory, 'fake-kitten']);
const fakeKitty = GLib.build_filenamev([temporaryDirectory, 'fake-kitty']);
const launchLog = GLib.build_filenamev([temporaryDirectory, 'launch.log']);

writeExecutable(
  fakeKitten,
  `#!/bin/sh
case "$*" in
  *unix:fail*) echo "simulated remote-control failure" >&2; exit 9 ;;
esac
destination=""
for argument in "$@"; do destination="$argument"; done
printf 'new_tab saved\\nlayout tall\\nlaunch\\n' > "$destination"
`,
);
writeExecutable(
  fakeKitty,
  `#!/bin/sh
printf '%s\\n' "$*" >> "$KITTY_TEST_LAUNCH_LOG"
`,
);
GLib.setenv('KITTY_TEST_LAUNCH_LOG', launchLog, true);

const client = new KittyClient({ timeoutSeconds: 3 });
const store = new SnapshotStore({
  baseDirectory: GLib.build_filenamev([temporaryDirectory, 'state']),
});

try {
  const first = await store.capture({
    captureInstance: (pid, destination) =>
      client.saveSession({
        destination,
        kittenCommand: fakeKitten,
        socketAddress: `unix:ok-${pid}`,
      }),
    pids: [22, 11, 22],
    reason: 'integration-test',
  });

  assert(first.manifest.instances.length === 2, 'Expected two deduplicated instances.');
  assert(first.manifest.instances[0].pid === 11, 'Expected deterministic PID ordering.');
  assert(
    first.sessionPaths.every((path) => readText(path).includes('launch')),
    'Session files missing.',
  );

  let failed = false;
  try {
    await store.capture({
      captureInstance: (pid, destination) =>
        client.saveSession({
          destination,
          kittenCommand: fakeKitten,
          socketAddress: `unix:fail-${pid}`,
        }),
      pids: [33],
      reason: 'expected-failure',
    });
  } catch (error) {
    failed = String(error).includes('simulated remote-control failure');
  }
  assert(failed, 'Expected the fake capture to fail.');

  const retained = store.loadCurrent();
  assert(retained !== null, 'The last good snapshot was not retained.');
  assert(
    retained.manifest.savedAt === first.manifest.savedAt,
    'A failed capture replaced current state.',
  );

  for (const sessionPath of retained.sessionPaths)
    await client.launchSession({ kittyCommand: fakeKitty, sessionPath });
  const launches = readText(launchLog).trim().split('\n');
  assert(launches.length === 2, 'Expected one Kitty launch per saved instance.');
  assert(
    launches.every((line) => line.startsWith('--detach --session ')),
    'Unexpected launch arguments.',
  );
} finally {
  client.stop();
  GLib.unsetenv('KITTY_TEST_LAUNCH_LOG');
  removeTree(temporaryDirectory);
}

print('GJS runtime integration tests passed.');
