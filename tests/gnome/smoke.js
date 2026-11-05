import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};

let indicatorFound = false;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tabCountLabel(item) {
  return item
    .get_children()
    .find((child) => child.has_style_class_name('kitty-session-restorer-tab-count'));
}

function codexBadge(item) {
  return item
    .get_children()
    .find((child) => child.has_style_class_name('kitty-session-restorer-codex-badge'));
}

async function testWindowMenu(indicator) {
  const original = {
    activateWindow: indicator._activateWindow,
    listWindows: indicator._listWindows,
    loadWindowDetails: indicator._loadWindowDetails,
    restore: indicator._restore,
  };
  let windows = [];
  let restores = 0;
  const activated = [];
  indicator._listWindows = () => [...windows];
  indicator._loadWindowDetails = async (snapshot) =>
    new Map(
      snapshot.map(({ metaWindow, directory, hasCodex }, index) => [
        metaWindow,
        { directory, hasCodex, tabCount: index + 1 },
      ]),
    );
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
    const first = {
      directory: '/home/stone/project-one',
      hasCodex: true,
      metaWindow: {},
      pid: 42,
      stableSequence: 1,
      title: 'Editor',
    };
    const second = {
      directory: '/srv/project-two',
      hasCodex: false,
      metaWindow: {},
      pid: 42,
      stableSequence: 2,
      title: 'Shell',
    };
    windows = [second, first];
    items = openMenu();
    assert(items.length === 2, 'The popup did not list every Kitty OS window.');
    assert(
      items[0].label.text === 'Editor' && items[1].label.text === 'Shell',
      'The popup did not show window titles in stable creation order.',
    );
    assert(activated.length === 0 && restores === 1, 'Opening the window list ran an action.');
    assert(!codexBadge(items[0]).visible, 'A Codex badge appeared before window details loaded.');
    await Promise.resolve();
    assert(
      items[0].label.text === first.directory && items[1].label.text === second.directory,
      'Window entries did not use their directory paths as titles.',
    );
    assert(
      tabCountLabel(items[0]).text === '1 tab' && tabCountLabel(items[1]).text === '2 tabs',
      'Window entries did not show their own tab counts.',
    );
    assert(
      codexBadge(items[0]).visible && codexBadge(items[0]).text === 'Codex',
      'The Codex window did not show its badge beside the title.',
    );
    assert(!codexBadge(items[1]).visible, 'A shell-only window showed a Codex badge.');
    items[1].activate(null);
    assert(
      activated.length === 1 &&
        activated[0].window === second.metaWindow &&
        activated[0].timestamp === undefined,
      'Selecting a window without an event did not activate that exact window.',
    );
    assert(!indicator.menu.isOpen, 'Window selection did not close the popup.');

    first.title = 'Updated title';
    first.directory = '/srv/updated-project';
    first.hasCodex = false;
    second.title = ' ';
    second.directory = undefined;
    second.hasCodex = true;
    items = openMenu();
    assert(items[0].label.text === 'Updated title', 'Reopening the popup kept a stale title.');
    assert(items[1].label.text === 'Kitty window 2', 'An untitled window has no fallback label.');
    await Promise.resolve();
    assert(items[0].label.text === first.directory, 'Reopening the popup kept a stale directory.');
    assert(
      items[1].label.text === 'Kitty window 2',
      'A missing directory lost its fallback label.',
    );
    assert(tabCountLabel(items[1]).text === '2 tabs', 'A missing directory lost its tab count.');
    assert(!codexBadge(items[0]).visible, 'Reopening the popup kept an obsolete Codex badge.');
    assert(codexBadge(items[1]).visible, 'A missing directory hid the Codex badge.');
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

    windows = [first];
    indicator._loadWindowDetails = async () => {
      throw new Error('Remote control unavailable');
    };
    items = openMenu();
    await Promise.resolve();
    assert(tabCountLabel(items[0]).text === 'Tabs unavailable', 'A failed count stayed pending.');
    assert(items[0].label.text === first.title, 'A failed query lost the fallback title.');
    assert(!codexBadge(items[0]).visible, 'A failed query showed a Codex badge.');
    items[0].activate(null);
    assert(activated.length === 2, 'A failed tab count prevented window activation.');

    let resolveDetails;
    indicator._loadWindowDetails = () =>
      new Promise((resolve) => {
        resolveDetails = resolve;
      });
    openMenu();
    const finishOldRequest = resolveDetails;
    items = openMenu();
    finishOldRequest(
      new Map([[first.metaWindow, { directory: '/stale', hasCodex: true, tabCount: 99 }]]),
    );
    await Promise.resolve();
    assert(tabCountLabel(items[0]).text === '…', 'A stale request updated the reopened menu.');
    assert(items[0].label.text === first.title, 'A stale request changed the directory title.');
    assert(!codexBadge(items[0]).visible, 'A stale request showed a Codex badge.');
    resolveDetails(
      new Map([[first.metaWindow, { directory: '/current', hasCodex: true, tabCount: 3 }]]),
    );
    await Promise.resolve();
    assert(tabCountLabel(items[0]).text === '3 tabs', 'The current request did not update counts.');
    assert(items[0].label.text === '/current', 'The current request did not update the title.');
    assert(codexBadge(items[0]).visible, 'The current request did not update the Codex badge.');

    items = openMenu();
    windows = [];
    resolveDetails(
      new Map([[first.metaWindow, { directory: '/closed', hasCodex: true, tabCount: 4 }]]),
    );
    await Promise.resolve();
    assert(
      tabCountLabel(items[0]).text === 'Tabs unavailable',
      'A changed window set received an obsolete count.',
    );
    assert(items[0].label.text === first.title, 'A closed window received an obsolete directory.');
    assert(!codexBadge(items[0]).visible, 'A changed window set received an obsolete Codex badge.');
  } finally {
    indicator.menu.close(false);
    indicator._activateWindow = original.activateWindow;
    indicator._listWindows = original.listWindows;
    indicator._loadWindowDetails = original.loadWindowDetails;
    indicator._restore = original.restore;
    indicator._refreshMenu();
  }
}

async function testMenuAlignment(indicator) {
  const original = {
    direction: indicator.menu.actor.text_direction,
    listWindows: indicator._listWindows,
    loadWindowDetails: indicator._loadWindowDetails,
    translationX: indicator.translation_x,
  };
  const window = { metaWindow: {}, pid: 42, stableSequence: 1, title: '' };
  indicator._listWindows = () => [window];
  indicator._loadWindowDetails = async () =>
    new Map([[window.metaWindow, { directory: window.directory, hasCodex: true, tabCount: 12 }]]);

  try {
    // Leave room on both sides, so monitor-edge clamping cannot mask the bug.
    const monitor = Main.layoutManager.primaryMonitor;
    const [buttonX] = indicator.get_transformed_position();
    const [buttonWidth] = indicator.get_transformed_size();
    indicator.translation_x += monitor.x + monitor.width / 2 - (buttonX + buttonWidth / 2);
    for (const direction of [Clutter.TextDirection.LTR, Clutter.TextDirection.RTL]) {
      indicator.menu.actor.text_direction = direction;
      for (const title of ['/tmp', '/home/stone/Web/deepx-trade-agents']) {
        window.directory = title;
        indicator.menu.open(false);
        await Scripting.sleep(100);
        const [sourceX] = indicator.get_transformed_position();
        const [sourceWidth] = indicator.get_transformed_size();
        const [popupX] = indicator.menu.actor.get_transformed_position();
        const [popupWidth] = indicator.menu.actor.get_transformed_size();
        assert(popupWidth > 0, 'The popup was not allocated.');
        assert(
          Math.abs(popupX + popupWidth / 2 - (sourceX + sourceWidth / 2)) <= 1,
          `The popup was not centered beneath its button (${title}, direction ${direction}).`,
        );
        indicator.menu.close(false);
      }
    }
  } finally {
    indicator.menu.close(false);
    indicator.translation_x = original.translationX;
    indicator.menu.actor.text_direction = original.direction;
    indicator._listWindows = original.listWindows;
    indicator._loadWindowDetails = original.loadWindowDetails;
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
  await testWindowMenu(indicator);
  await testMenuAlignment(indicator);
}

export function finish() {
  if (!indicatorFound) throw new Error('Kitty Session Restorer smoke test did not complete.');
}
