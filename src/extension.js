import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { EXTENSION_NAME } from './lib/constants.js';
import { KittyClient } from './lib/kittyClient.js';
import { SessionController } from './lib/sessionController.js';
import { SnapshotStore } from './lib/snapshotStore.js';
import { KittyWindowTracker } from './lib/windowTracker.js';

class RestoreIndicator extends PanelMenu.Button {
  static {
    GObject.registerClass(RestoreIndicator);
  }

  constructor(iconPath, { listWindows, activateWindow, restore }) {
    super(0, EXTENSION_NAME);
    this._listWindows = listWindows;
    this._activateWindow = activateWindow;
    this._restore = restore;

    const iconFile = Gio.File.new_for_path(iconPath);
    this._icon = new St.Icon({
      gicon: new Gio.FileIcon({ file: iconFile }),
      style_class: 'system-status-icon',
    });
    this.add_child(this._icon);

    this.menu.connect('open-state-changed', (_menu, isOpen) => {
      if (isOpen) this._refreshMenu();
    });
    this._refreshMenu();
  }

  _refreshMenu() {
    this.menu.removeAll();
    const windows = this._listWindows().sort(
      (left, right) => (left.stableSequence ?? 0) - (right.stableSequence ?? 0),
    );
    if (windows.length === 0) {
      const item = new PopupMenu.PopupMenuItem('Restore');
      item.connect('activate', () => this._restore());
      this.menu.addMenuItem(item);
      return;
    }

    for (const [index, window] of windows.entries()) {
      const item = new PopupMenu.PopupMenuItem(window.title?.trim() || `Kitty window ${index + 1}`);
      item.label.add_style_class_name('kitty-session-restorer-window-title');
      item.connect('activate', (_item, event) => {
        // A window may close while the popup is open.
        if (this._listWindows().some(({ metaWindow }) => metaWindow === window.metaWindow))
          this._activateWindow(window.metaWindow, event?.get_time());
      });
      this.menu.addMenuItem(item);
    }
  }

  setStatus(status) {
    this.remove_style_class_name('kitty-session-restorer-busy');
    this.remove_style_class_name('kitty-session-restorer-error');
    if (status === 'saving' || status === 'restoring')
      this.add_style_class_name('kitty-session-restorer-busy');
    else if (status === 'error') this.add_style_class_name('kitty-session-restorer-error');

    const suffix = {
      error: ' — session save failed',
      restoring: ' — restoring',
      saving: ' — saving',
    }[status];
    this.accessible_name = `${EXTENSION_NAME}${suffix ?? ''}`;
  }
}

export default class KittySessionRestorerExtension extends Extension {
  enable() {
    const settings = this.getSettings();
    const tracker = new KittyWindowTracker(settings);
    const store = new SnapshotStore();
    const client = new KittyClient();

    this._indicator = new RestoreIndicator(`${this.path}/icons/kitty-paw-symbolic.svg`, {
      activateWindow: (window, timestamp) => Main.activateWindow(window, timestamp),
      listWindows: () => tracker.listKittyWindows(),
      restore: () => void this._controller?.restore(),
    });
    Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

    this._controller = new SessionController({
      client,
      notify: (title, body) => Main.notify(title, body),
      onStatusChanged: (status) => this._indicator?.setStatus(status),
      settings,
      store,
      tracker,
    });
    this._controller.start();
  }

  disable() {
    this._controller?.stop();
    this._controller = null;
    this._indicator?.destroy();
    this._indicator = null;
  }
}
