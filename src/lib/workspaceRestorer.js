import GLib from 'gi://GLib';

const RESTORE_POLL_MILLISECONDS = 100;
const RESTORE_TIMEOUT_SECONDS = 15;

export class WorkspaceRestorer {
  constructor({
    currentTime,
    listWindows,
    workspaceManager,
    timeoutSeconds = RESTORE_TIMEOUT_SECONDS,
  }) {
    this._currentTime = currentTime;
    this._listWindows = listWindows;
    this._workspaceManager = workspaceManager;
    this._timeoutSeconds = timeoutSeconds;
    this._waiters = new Set();
    this._stopped = true;
  }

  start() {
    this._stopped = false;
  }

  stop() {
    this._stopped = true;
    for (const waiter of [...this._waiters])
      waiter.cancel(new Error('Kitty workspace restoration stopped.'));
  }

  async restore({ launch, workspaces }) {
    if (this._stopped) throw new Error('Kitty workspace restoration has stopped.');
    const knownWindows = new Set(this._listWindows().map(({ metaWindow }) => metaWindow));
    const waiter = this._waitForNewWindows(workspaces.length, knownWindows);

    try {
      await launch();
    } catch (error) {
      waiter.cancel();
      throw error;
    }

    const result = await waiter.promise;
    if (result.error) throw result.error;
    const windows = result.windows;
    for (const [index, workspaceIndex] of workspaces.entries()) {
      if (workspaceIndex === null) continue;
      windows[index].change_workspace(this._ensureWorkspace(workspaceIndex));
    }
  }

  _waitForNewWindows(count, knownWindows) {
    let resolvePromise;
    let settled = false;
    let sourceId = 0;
    const deadline = GLib.get_monotonic_time() + this._timeoutSeconds * GLib.USEC_PER_SEC;

    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    const waiter = {
      cancel: (error = null) => {
        if (settled) return;
        settled = true;
        if (sourceId) GLib.Source.remove(sourceId);
        sourceId = 0;
        this._waiters.delete(waiter);
        resolvePromise({ error, windows: null });
      },
      promise,
    };

    this._waiters.add(waiter);
    sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTORE_POLL_MILLISECONDS, () => {
      const windows = this._listWindows()
        .filter(({ metaWindow }) => !knownWindows.has(metaWindow))
        .sort(
          (left, right) =>
            (left.stableSequence ?? Number.MAX_SAFE_INTEGER) -
            (right.stableSequence ?? Number.MAX_SAFE_INTEGER),
        );
      if (windows.length >= count) {
        settled = true;
        sourceId = 0;
        this._waiters.delete(waiter);
        resolvePromise({
          error: null,
          windows: windows.slice(0, count).map(({ metaWindow }) => metaWindow),
        });
        return GLib.SOURCE_REMOVE;
      }
      if (GLib.get_monotonic_time() >= deadline) {
        settled = true;
        sourceId = 0;
        this._waiters.delete(waiter);
        resolvePromise({
          error: new Error(
            `Timed out waiting for ${count} restored Kitty ${count === 1 ? 'window' : 'windows'}.`,
          ),
          windows: null,
        });
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    });

    return waiter;
  }

  _ensureWorkspace(index) {
    while (this._workspaceManager.get_n_workspaces() <= index) {
      const previousCount = this._workspaceManager.get_n_workspaces();
      this._workspaceManager.append_new_workspace(false, this._currentTime());
      if (this._workspaceManager.get_n_workspaces() <= previousCount)
        throw new Error(`Could not create GNOME workspace ${index + 1}.`);
    }

    const workspace = this._workspaceManager.get_workspace_by_index(index);
    if (!workspace) throw new Error(`GNOME workspace ${index + 1} is unavailable.`);
    return workspace;
  }
}
