import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};

let indicatorFound = false;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function testWindowMenu(indicator) {
  const original = {
    activateWindow: indicator._activateWindow,
    listWindows: indicator._listWindows,
    restore: indicator._restore,
  };
  let windows = [];
  let restores = 0;
  const activated = [];
  indicator._listWindows = () => [...windows];
  indicator._activateWindow = (window, timestamp) => activated.push({ timestamp, window });
  indicator._restore = () => restores++;
  const openMenu = () => {
    indicator.menu.close(false);
    indicator.menu.open(false);
    return indicator.menu._getMenuItems();
  };

  try {
    let items = openMenu();
    assert(indicator.menu.isOpen, 'The panel popup did not open.');
    assert(items.length === 1 && items[0].label.text === 'Restore', 'Missing restore action.');
    assert(restores === 0, 'Opening the popup restored a session.');
    items[0].activate(null);
    assert(restores === 1, 'The restore action did not invoke the controller callback.');
    assert(!indicator.menu.isOpen, 'Restore did not close the popup.');

    // Multiple OS windows from the same process must remain separate entries.
    const first = { metaWindow: {}, pid: 42, stableSequence: 1, title: 'Editor' };
    const second = { metaWindow: {}, pid: 42, stableSequence: 2, title: 'Shell' };
    windows = [second, first];
    items = openMenu();
    assert(items.length === 2, 'The popup did not list every Kitty OS window.');
    assert(
      items[0].label.text === 'Editor' && items[1].label.text === 'Shell',
      'The popup did not show window titles in stable creation order.',
    );
    assert(activated.length === 0 && restores === 1, 'Opening the window list ran an action.');
    items[1].activate(null);
    assert(
      activated.length === 1 &&
        activated[0].window === second.metaWindow &&
        activated[0].timestamp === undefined,
      'Selecting a window without an event did not activate that exact window.',
    );
    assert(!indicator.menu.isOpen, 'Window selection did not close the popup.');

    first.title = 'Updated title';
    second.title = ' ';
    items = openMenu();
    assert(items[0].label.text === 'Updated title', 'Reopening the popup kept a stale title.');
    assert(items[1].label.text === 'Kitty window 2', 'An untitled window has no fallback label.');
    windows = [];
    items[0].activate(null);
    assert(activated.length === 1, 'Selecting a closed window attempted to activate it.');

    items = openMenu();
    assert(
      items.length === 1 && items[0].label.text === 'Restore',
      'Closing all windows did not bring back the restore action.',
    );
    items[0].activate(null);
    assert(restores === 2, 'The refreshed restore action did not work.');
  } finally {
    indicator.menu.close(false);
    indicator._activateWindow = original.activateWindow;
    indicator._listWindows = original.listWindows;
    indicator._restore = original.restore;
    indicator._refreshMenu();
  }
}

export async function run() {
  let indicator = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    indicator = Main.panel.statusArea['kitty-session-restorer@stone.dev'];
    if (indicator) break;
    await Scripting.sleep(100);
  }
  if (!indicator) throw new Error('Kitty Session Restorer did not register a panel indicator.');
  if (!indicator.visible) throw new Error('Kitty Session Restorer panel indicator is not visible.');
  if (!indicator.get_first_child())
    throw new Error('Kitty Session Restorer panel icon is missing.');
  indicatorFound = true;
  await Scripting.waitLeisure();
  testWindowMenu(indicator);
}

export function finish() {
  if (!indicatorFound) throw new Error('Kitty Session Restorer smoke test did not complete.');
}
