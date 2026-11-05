import GLib from 'gi://GLib';

import { SETTINGS_KEYS } from '../../src/lib/constants.js';
import { KittyClient } from '../../src/lib/kittyClient.js';
import { SessionController } from '../../src/lib/sessionController.js';
import { SnapshotStore } from '../../src/lib/snapshotStore.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readText(path) {
  const [, contents] = GLib.file_get_contents(path);
  return new TextDecoder().decode(contents);
}

export async function runForegroundCaptureTests(temporaryDirectory) {
  const fakeKitten = `${temporaryDirectory}/alias-kitten`;
  const threadId = '019c0123-4567-789a-bcde-f0123456789a';
  const payload = `kitty-unserialize-data=${JSON.stringify({ id: 7, cmd_at_shell_startup: 'ac' })}`;
  const session = `launch ${GLib.shell_quote(payload)} --var=kitty_session_restorer_codex_thread_id=${threadId}`;
  const withoutThread = `launch ${GLib.shell_quote(payload)}`;
  const windows = JSON.stringify([
    {
      tabs: [
        {
          windows: [
            {
              id: 7,
              at_prompt: false,
              last_reported_cmdline: 'ac',
              foreground_processes: [{ cmdline: ['codex', '--no-daemon', '-a', 'never'] }],
            },
          ],
        },
      ],
    },
  ]);
  const liveWindows = JSON.parse(windows);
  liveWindows[0].tabs[0].windows[0].user_vars = {
    kitty_session_restorer_codex_thread_id: threadId,
  };
  GLib.file_set_contents(
    fakeKitten,
    `#!/bin/sh
if [ "$4" = ls ]; then
  case "$3" in
    *-33) echo 'simulated foreground listing failure' >&2; exit 9 ;;
    *-22) printf '%s\\n' ${GLib.shell_quote(JSON.stringify(liveWindows))}; exit 0 ;;
  esac
  printf '%s\\n' ${GLib.shell_quote(windows)}
else
  for destination in "$@"; do :; done
  case "$3" in
    *-11) printf '%s\\n' ${GLib.shell_quote(session)} > "$destination" ;;
    *) printf '%s\\n' ${GLib.shell_quote(withoutThread)} > "$destination" ;;
  esac
fi
`,
  );
  GLib.chmod(fakeKitten, 0o700);

  let pid = 11;
  let foregroundEnabled = true;
  const statuses = [];
  const client = new KittyClient({ timeoutSeconds: 3 });
  const store = new SnapshotStore({ baseDirectory: `${temporaryDirectory}/alias-state` });
  const controller = new SessionController({
    client,
    store,
    logger: { error() {} },
    notify() {},
    onStatusChanged: (status) => statuses.push(status),
    settings: {
      connect: () => 1,
      disconnect() {},
      get_boolean: () => foregroundEnabled,
      get_string: (key) => (key === SETTINGS_KEYS.socketTemplate ? 'unix:/fake-{pid}' : fakeKitten),
      get_strv: () => ['codex'],
      get_uint: () => 300,
    },
    tracker: {
      kittyInstances: () => [{ pid }],
      start() {},
      stop() {},
    },
  });
  controller.start();
  try {
    await controller._capture('alias-regression');
    const first = await store.loadCurrent();
    assert(first !== null, 'Alias capture did not publish a snapshot.');
    assert(
      readText(first.sessionPaths[0]).includes(
        `"cmd_at_shell_startup":["codex","resume","${threadId}","--no-daemon","-a","never"]`,
      ),
      'An aliased Codex launch did not save its exact thread and actual options.',
    );

    pid = 22;
    await controller._capture('late-thread-hook');
    const lateHook = await store.loadCurrent();
    assert(
      readText(lateHook.sessionPaths[0]).includes(
        `"cmd_at_shell_startup":["codex","resume","${threadId}"`,
      ),
      'Thread metadata from the matching live pane did not produce a direct resume.',
    );

    pid = 44;
    await controller._capture('missing-thread');
    const missingThread = await store.loadCurrent();
    assert(
      !readText(missingThread.sessionPaths[0]).includes('cmd_at_shell_startup'),
      'Missing thread metadata produced an automatic Codex picker instead of a shell.',
    );

    pid = 33;
    await controller._capture('failed-listing');
    assert(statuses.at(-1) === 'error', 'A failed foreground lookup was ignored.');
    assert(
      (await store.loadCurrent()).manifest.reason === 'missing-thread',
      'A failed foreground lookup replaced the last complete snapshot.',
    );

    foregroundEnabled = false;
    await controller._capture('foreground-disabled');
    assert(
      (await store.loadCurrent()).manifest.reason === 'foreground-disabled',
      'Foreground-disabled capture unnecessarily queried foreground processes.',
    );
  } finally {
    controller.stop();
  }
}
