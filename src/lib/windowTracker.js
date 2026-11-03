import Shell from 'gi://Shell';

import { SETTINGS_KEYS } from './constants.js';
import { collectKittyInstances, collectKittyPids, matchesKittyWindow } from './policy.js';
import { WorkspaceRestorer } from './workspaceRestorer.js';

function safeCall(callback, fallback = null) {
  try {
    return callback() ?? fallback;
  } catch {
    return fallback;
  }
}

export class KittyWindowTracker {
  constructor(settings, runtime = {}) {
    this._settings = settings;
    this._windowTracker = runtime.windowTracker ?? Shell.WindowTracker.get_default();
    this._display = runtime.display ?? global.display;
    this._windowManager = runtime.windowManager ?? global.window_manager;
    this._listWindowActors = runtime.listWindowActors ?? (() => global.get_window_actors());
    this._workspaceRestorer =
      runtime.workspaceRestorer ??
      new WorkspaceRestorer({
        currentTime: runtime.currentTime ?? (() => global.get_current_time()),
        listWindows: () => this.listKittyWindows(),
        timeoutSeconds: runtime.restoreTimeoutSeconds,
        workspaceManager: runtime.workspaceManager ?? global.workspace_manager,
      });
    this._signals = [];
    this._onChanged = null;
  }

  start(onChanged) {
    if (this._signals.length > 0) return;
    this._workspaceRestorer.start();
    this._onChanged = onChanged;

    this._signals.push([
      this._display,
      this._display.connect('window-created', () => this._onChanged?.('window-created')),
    ]);
    this._signals.push([
      this._display,
      this._display.connect('notify::focus-window', () => {
        if (this.hasKittyWindows()) this._onChanged?.('focus-changed');
      }),
    ]);
    this._signals.push([
      this._windowManager,
      this._windowManager.connect('destroy', (_manager, actor) => {
        if (this._matchesMetaWindow(actor?.meta_window)) this._onChanged?.('window-destroyed');
      }),
    ]);
  }

  stop() {
    for (const [object, signalId] of this._signals) object.disconnect(signalId);
    this._signals = [];
    this._workspaceRestorer.stop();
    this._onChanged = null;
  }

  hasKittyWindows() {
    return this.listKittyWindows().length > 0;
  }

  kittyPids() {
    return collectKittyPids(
      this.listWindowSnapshots(),
      this._settings.get_strv(SETTINGS_KEYS.windowIdentifiers),
    );
  }

  kittyInstances() {
    return collectKittyInstances(
      this.listWindowSnapshots(),
      this._settings.get_strv(SETTINGS_KEYS.windowIdentifiers),
    );
  }

  listKittyWindows() {
    const identifiers = this._settings.get_strv(SETTINGS_KEYS.windowIdentifiers);
    return this.listWindowSnapshots().filter((window) => matchesKittyWindow(window, identifiers));
  }

  listWindowSnapshots() {
    const windows = [];
    for (const actor of this._listWindowActors()) {
      const metaWindow = actor.meta_window;
      if (!metaWindow) continue;

      const app = safeCall(() => this._windowTracker.get_window_app(metaWindow));
      windows.push({
        appId: safeCall(() => app?.get_id(), ''),
        metaWindow,
        pid: safeCall(() => metaWindow.get_pid(), -1),
        stableSequence: safeCall(() => metaWindow.get_stable_sequence(), null),
        title: safeCall(() => metaWindow.get_title(), ''),
        workspaceIndex: safeCall(() => metaWindow.get_workspace()?.index(), null),
        wmClass: safeCall(() => metaWindow.get_wm_class(), ''),
        wmClassInstance: safeCall(() => metaWindow.get_wm_class_instance(), ''),
      });
    }
    return windows;
  }

  async restoreWorkspaces({ launch, workspaces }) {
    await this._workspaceRestorer.restore({ launch, workspaces });
  }

  _matchesMetaWindow(metaWindow) {
    if (!metaWindow) return false;
    const app = safeCall(() => this._windowTracker.get_window_app(metaWindow));
    return matchesKittyWindow(
      {
        appId: safeCall(() => app?.get_id(), ''),
        pid: safeCall(() => metaWindow.get_pid(), -1),
        wmClass: safeCall(() => metaWindow.get_wm_class(), ''),
        wmClassInstance: safeCall(() => metaWindow.get_wm_class_instance(), ''),
      },
      this._settings.get_strv(SETTINGS_KEYS.windowIdentifiers),
    );
  }
}
