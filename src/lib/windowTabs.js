function activeEntry(entries) {
  if (!Array.isArray(entries)) return undefined;
  const active = entries.filter((entry) => entry?.is_active === true);
  if (active.length === 1) return active[0];
  if (active.length === 0 && entries.length === 1) return entries[0];
  return undefined;
}

function activeDirectory(osWindow) {
  const tab = activeEntry(osWindow.tabs);
  const terminal = activeEntry(tab?.windows);
  const cwd = terminal?.cwd;
  return typeof cwd === 'string' && cwd.trim() ? cwd : undefined;
}

function hasCodexProcess(osWindow) {
  return osWindow.tabs.some((tab) =>
    (Array.isArray(tab?.windows) ? tab.windows : []).some((terminal) =>
      (Array.isArray(terminal?.foreground_processes) ? terminal.foreground_processes : []).some(
        (process) => {
          const command = process?.cmdline;
          return (
            Array.isArray(command) &&
            typeof command[0] === 'string' &&
            command[0].split('/').at(-1) === 'codex'
          );
        },
      ),
    ),
  );
}

export function matchWindowTabDetails(windows, osWindows) {
  const details = new Map();
  if (!Array.isArray(osWindows) || windows.length !== osWindows.length) return details;
  if (
    osWindows.some(
      (window) =>
        !Number.isSafeInteger(window?.id) || window.id <= 0 || !Array.isArray(window.tabs),
    ) ||
    new Set(osWindows.map(({ id }) => id)).size !== osWindows.length
  )
    return details;
  if (
    windows.length > 1 &&
    (windows.some(({ stableSequence }) => !Number.isSafeInteger(stableSequence)) ||
      new Set(windows.map(({ stableSequence }) => stableSequence)).size !== windows.length)
  )
    return details;

  // Kitty OS-window IDs and Mutter stable sequences both follow creation order.
  // Require the complete set for this PID so a closing/unmapped window cannot
  // shift another window's directory or count onto the wrong entry.
  const ordered = [...windows].sort((left, right) => left.stableSequence - right.stableSequence);
  const remote = [...osWindows].sort((left, right) => left.id - right.id);
  for (const [index, window] of ordered.entries()) {
    const osWindow = remote[index];
    details.set(window.metaWindow, {
      directory: activeDirectory(osWindow),
      hasCodex: hasCodexProcess(osWindow),
      tabCount: osWindow.tabs.length,
    });
  }
  return details;
}

export class WindowTabLoader {
  constructor({ listWindows }) {
    this._listWindows = listWindows;
    this._pending = new Map();
    this._stopped = false;
  }

  async load(windows) {
    const details = new Map();
    const groups = new Map();
    for (const window of windows) {
      if (!Number.isSafeInteger(window.pid) || window.pid <= 0) continue;
      if (!groups.has(window.pid)) groups.set(window.pid, []);
      groups.get(window.pid).push(window);
    }

    for (const [pid, group] of groups) {
      if (this._stopped) break;
      let request = this._pending.get(pid);
      if (!request) {
        request = Promise.resolve().then(() => (this._stopped ? [] : this._listWindows(pid)));
        this._pending.set(pid, request);
      }
      try {
        const remote = await request;
        if (this._stopped) break;
        for (const [window, info] of matchWindowTabDetails(group, remote))
          details.set(window, info);
      } catch {
        // Details are optional; a remote-control failure must not prevent focusing.
      } finally {
        if (this._pending.get(pid) === request) this._pending.delete(pid);
      }
    }
    return details;
  }

  stop() {
    this._stopped = true;
    this._pending.clear();
  }
}
