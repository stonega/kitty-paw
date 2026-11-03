import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { codexHookStatus, installCodexHooks } from '../../src/lib/codexHookInstaller.js';
import { hasConfiguredCodexHooks } from '../../src/lib/codexHooks.js';
import { CODEX_THREAD_VARIABLE } from '../../src/lib/codexSession.js';
import { KittyClient } from '../../src/lib/kittyClient.js';
import { SessionController } from '../../src/lib/sessionController.js';
import { prepareSavedSession } from '../../src/lib/sessionFile.js';
import { SnapshotStore } from '../../src/lib/snapshotStore.js';
import { WorkspaceRestorer } from '../../src/lib/workspaceRestorer.js';
import { runPerformanceTests } from './performance.js';

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
const fakeHookKitten = GLib.build_filenamev([temporaryDirectory, 'fake-hook-kitten']);
const fakeKitty = GLib.build_filenamev([temporaryDirectory, 'fake-kitty']);
const hookLog = GLib.build_filenamev([temporaryDirectory, 'hook.log']);
const launchLog = GLib.build_filenamev([temporaryDirectory, 'launch.log']);
const threadId = '019c0123-4567-789a-bcde-f0123456789a';

writeExecutable(
  fakeKitten,
  `#!/bin/sh
case "$*" in
  *unix:fail*) echo "simulated remote-control failure" >&2; exit 9 ;;
esac
destination=""
for argument in "$@"; do destination="$argument"; done
case "$*" in
  *--use-foreground-process*)
    printf '%s\\n' "launch 'kitty-unserialize-data={\\"id\\":4,\\"cmd_at_shell_startup\\":[\\"/usr/bin/codex\\",\\"--profile\\",\\"work\\",\\"resume\\",\\"--last\\",\\"deploy again\\"]}' --var=${CODEX_THREAD_VARIABLE}=${threadId}" > "$destination"
    ;;
  *)
    printf 'new_tab saved\\nlayout tall\\nlaunch\\n' > "$destination"
    ;;
esac
`,
);
writeExecutable(
  fakeHookKitten,
  `#!/bin/sh
printf '%s\\n' "$*" >> "$KITTY_TEST_HOOK_LOG"
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
  const codexDirectory = GLib.build_filenamev([temporaryDirectory, 'codex-config']);
  GLib.mkdir_with_parents(codexDirectory, 0o700);
  const hooksPath = GLib.build_filenamev([codexDirectory, 'hooks.json']);
  GLib.file_set_contents(
    hooksPath,
    JSON.stringify({
      custom: 'preserved',
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ command: '/usr/bin/existing-hook', type: 'command' }],
          },
        ],
      },
    }),
  );
  installCodexHooks(codexDirectory);
  const installedHooks = JSON.parse(readText(hooksPath));
  assert(installedHooks.custom === 'preserved', 'Codex hook setup replaced a custom property.');
  assert(
    installedHooks.hooks.UserPromptSubmit[0].hooks[0].command === '/usr/bin/existing-hook',
    'Codex hook setup replaced an unrelated hook.',
  );
  assert(hasConfiguredCodexHooks(installedHooks), 'Codex hook setup omitted a managed hook.');
  assert(codexHookStatus(codexDirectory).configured, 'Codex hook status was not detected.');

  const hookLauncher = new Gio.SubprocessLauncher({
    flags:
      Gio.SubprocessFlags.STDIN_PIPE |
      Gio.SubprocessFlags.STDOUT_PIPE |
      Gio.SubprocessFlags.STDERR_PIPE,
  });
  hookLauncher.setenv('KITTY_WINDOW_ID', '42', true);
  hookLauncher.setenv('KITTY_SESSION_RESTORER_KITTEN_COMMAND', fakeHookKitten, true);
  hookLauncher.setenv('KITTY_TEST_HOOK_LOG', hookLog, true);
  const hookProcess = hookLauncher.spawnv([
    'gjs',
    '-m',
    GLib.build_filenamev([GLib.get_current_dir(), 'src', 'lib', 'codexSessionHook.js']),
  ]);
  const [, hookStderr] = await hookProcess.communicate_utf8_async(
    JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: threadId,
      source: 'fork',
    }),
    null,
  );
  assert(
    hookProcess.get_successful(),
    `Codex session hook failed: ${hookStderr.trim() || 'unknown error'}`,
  );
  assert(
    readText(hookLog).trim() ===
      `@ set-user-vars --match id:42 ${CODEX_THREAD_VARIABLE}=${threadId}`,
    'Codex session hook did not attach the exact thread ID to its Kitty window.',
  );
  const endHookProcess = hookLauncher.spawnv([
    'gjs',
    '-m',
    GLib.build_filenamev([GLib.get_current_dir(), 'src', 'lib', 'codexSessionHook.js']),
  ]);
  const [, endHookStderr] = await endHookProcess.communicate_utf8_async(
    JSON.stringify({
      hook_event_name: 'SessionEnd',
      session_id: threadId,
    }),
    null,
  );
  assert(
    endHookProcess.get_successful(),
    `Codex session end hook failed: ${endHookStderr.trim() || 'unknown error'}`,
  );
  assert(
    readText(hookLog)
      .trim()
      .endsWith(
        `@ set-user-vars --match id:42 and var:${CODEX_THREAD_VARIABLE}=${threadId} ${CODEX_THREAD_VARIABLE}`,
      ),
    'Codex session end hook did not clear its Kitty window thread ID.',
  );

  const first = await store.capture({
    captureInstance: (pid, destination) =>
      client.saveSession({
        destination,
        kittenCommand: fakeKitten,
        socketAddress: `unix:ok-${pid}`,
        useForegroundProcesses: true,
      }),
    instances: [
      { pid: 22, workspaces: [2] },
      { pid: 11, workspaces: [0, 1] },
      { pid: 22, workspaces: [2] },
    ],
    processSession: (contents) => prepareSavedSession(contents, ['codex']),
    reason: 'integration-test',
  });

  assert(first.manifest.instances.length === 2, 'Expected two deduplicated instances.');
  assert(first.manifest.instances[0].pid === 11, 'Expected deterministic PID ordering.');
  assert(
    first.manifest.instances[0].workspaces.join(',') === '0,1',
    'Expected workspace assignments in the manifest.',
  );
  assert(
    first.sessionPaths.every((path) =>
      readText(path).includes(
        `"cmd_at_shell_startup":["/usr/bin/codex","resume","${threadId}","--profile","work"]`,
      ),
    ),
    'Foreground Codex sessions were not linked to the exact saved thread.',
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
      instances: [{ pid: 33, workspaces: [0] }],
      reason: 'expected-failure',
    });
  } catch (error) {
    failed = String(error).includes('simulated remote-control failure');
  }
  assert(failed, 'Expected the fake capture to fail.');

  const retained = await store.loadCurrent();
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

  let restoredWindows = [];
  const workspaces = [];
  const workspaceManager = {
    append_new_workspace() {
      const index = workspaces.length;
      workspaces.push({ index: () => index });
    },
    get_n_workspaces() {
      return workspaces.length;
    },
    get_workspace_by_index(index) {
      return workspaces[index] ?? null;
    },
  };
  workspaceManager.append_new_workspace();
  const movedTo = [];
  const createWindow = ({ pid, sequence, workspaceIndex }) => ({
    change_workspace(workspace) {
      movedTo.push(workspace.index());
    },
    pid,
    sequence,
    workspaceIndex,
  });
  const workspaceRestorer = new WorkspaceRestorer({
    currentTime: () => 1,
    listWindows: () => restoredWindows,
    timeoutSeconds: 1,
    workspaceManager,
  });
  workspaceRestorer.start();
  await workspaceRestorer.restore({
    launch: async () => {
      const laterWindow = createWindow({ pid: 55, sequence: 40, workspaceIndex: 0 });
      const earlierWindow = createWindow({ pid: 55, sequence: 30, workspaceIndex: 0 });
      restoredWindows = [
        { metaWindow: laterWindow, stableSequence: laterWindow.sequence },
        { metaWindow: earlierWindow, stableSequence: earlierWindow.sequence },
      ];
    },
    workspaces: [2, 0],
  });
  assert(movedTo.join(',') === '2,0', 'Restored windows were not moved to saved workspaces.');
  assert(workspaceManager.get_n_workspaces() === 3, 'Missing workspaces were not created.');
  workspaceRestorer.stop();

  const stoppedRestorer = new WorkspaceRestorer({
    currentTime: () => 1,
    listWindows: () => [],
    timeoutSeconds: 1,
    workspaceManager,
  });
  stoppedRestorer.start();
  const stoppedRestore = stoppedRestorer.restore({
    launch: async () => {},
    workspaces: [0],
  });
  stoppedRestorer.stop();
  let cancellationObserved = false;
  try {
    await stoppedRestore;
  } catch (error) {
    cancellationObserved = String(error).includes('stopped');
  }
  assert(cancellationObserved, 'Stopping workspace restoration did not cancel its polling source.');

  const restoredWorkspaces = [];
  const controllerTracker = {
    hasKittyWindows: () => false,
    kittyInstances: () => [],
    restoreWorkspaces: async ({ launch, workspaces: assignments }) => {
      restoredWorkspaces.push(assignments);
      await launch();
    },
    start() {},
    stop() {},
  };
  let settingsSignal = 0;
  const settings = {
    connect() {
      settingsSignal += 1;
      return settingsSignal;
    },
    disconnect() {},
    get_string() {
      return fakeKitty;
    },
    get_boolean() {
      return true;
    },
    get_uint() {
      return 300;
    },
  };
  const controllerLaunches = [];
  const controller = new SessionController({
    client: {
      launchSession: async ({ sessionPath }) => controllerLaunches.push(sessionPath),
      stop() {},
    },
    logger: { error() {} },
    notify() {},
    onStatusChanged() {},
    settings,
    store: { loadCurrent: () => retained },
    tracker: controllerTracker,
  });
  controller.start();
  await controller.restore();
  controller.stop();
  assert(controllerLaunches.length === 2, 'Controller did not launch every saved instance.');
  assert(
    restoredWorkspaces.map((assignments) => assignments.join(',')).join('|') === '0,1|2',
    'Controller did not apply each saved instance workspace list.',
  );
  await runPerformanceTests(temporaryDirectory);
} finally {
  client.stop();
  GLib.unsetenv('KITTY_TEST_LAUNCH_LOG');
  removeTree(temporaryDirectory);
}

print('GJS runtime integration tests passed.');
