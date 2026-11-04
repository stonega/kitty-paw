import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { EXTENSION_NAME, SETTINGS_KEYS } from './lib/constants.js';
import { KittyClient } from './lib/kittyClient.js';
import { expandSocketTemplate } from './lib/policy.js';
import { SessionController } from './lib/sessionController.js';
import { SnapshotStore } from './lib/snapshotStore.js';
import { WindowTabLoader } from './lib/windowTabs.js';
import { KittyWindowTracker } from './lib/windowTracker.js';

class RestoreIndicator extends PanelMenu.Button {
  static {
    GObject.registerClass(RestoreIndicator);
  }

  constructor(iconPath, { listWindows, loadWindowDetails, activateWindow, restore }) {
    super(0.5, EXTENSION_NAME);
    this._listWindows = listWindows;
    this._loadWindowDetails = loadWindowDetails;
    this._activateWindow = activateWindow;
    this._restore = restore;
    this._menuGeneration = 0;
    this._destroyed = false;
    this.connect('destroy', () => {
      this._destroyed = true;
      this._menuGeneration++;
    });

    const iconFile = Gio.File.new_for_path(iconPath);
    this._icon = new St.Icon({
      gicon: new Gio.FileIcon({ file: iconFile }),
      style_class: 'system-status-icon',
    });
    this.add_child(this._icon);

    this.menu.connect('open-state-changed', (_menu, isOpen) => {
      if (isOpen) this._refreshMenu();
      else this._menuGeneration++;
    });
    this._refreshMenu();
  }

  _refreshMenu() {
    const generation = ++this._menuGeneration;
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

    const labels = new Map();
    for (const [index, window] of windows.entries()) {
      const item = new PopupMenu.PopupMenuItem(window.title?.trim() || `Kitty window ${index + 1}`);
      item.label.add_style_class_name('kitty-session-restorer-window-title');
      const countLabel = new St.Label({
        text: '…',
        style_class: 'kitty-session-restorer-tab-count dim-label',
        x_expand: true,
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
      });
      item.add_child(countLabel);
      labels.set(window.metaWindow, { count: countLabel, title: item.label });
      item.connect('activate', (_item, event) => {
        // A window may close while the popup is open.
        if (this._listWindows().some(({ metaWindow }) => metaWindow === window.metaWindow))
          this._activateWindow(window.metaWindow, event?.get_time());
      });
      this.menu.addMenuItem(item);
    }
    if (this.menu.isOpen) void this._updateWindowDetails(windows, labels, generation);
  }

  async _updateWindowDetails(windows, labels, generation) {
    let details;
    try {
      details = await this._loadWindowDetails(windows);
    } catch {
      details = new Map();
    }
    if (this._destroyed || generation !== this._menuGeneration) return;
    const current = this._listWindows();
    for (const window of windows) {
      // Ignore a process's details if any of its OS windows changed during IO.
      const previousGroup = windows.filter(({ pid }) => pid === window.pid);
      const currentGroup = current.filter(({ pid }) => pid === window.pid);
      const unchanged =
        previousGroup.length === currentGroup.length &&
        previousGroup.every(({ metaWindow }) =>
          currentGroup.some((candidate) => candidate.metaWindow === metaWindow),
        );
      const info = unchanged ? details.get(window.metaWindow) : undefined;
      const entry = labels.get(window.metaWindow);
      if (info?.directory) entry.title.text = info.directory;
      const count = info?.tabCount;
      entry.count.text =
        count === undefined ? 'Tabs unavailable' : `${count} ${count === 1 ? 'tab' : 'tabs'}`;
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
    const tabLoader = new WindowTabLoader({
      listWindows: (pid) =>
        client.listWindows({
          kittenCommand: settings.get_string(SETTINGS_KEYS.kittenCommand),
          socketAddress: expandSocketTemplate(
            settings.get_string(SETTINGS_KEYS.socketTemplate),
            pid,
            {
              runtimeDir: GLib.get_user_runtime_dir(),
              uid: String(Gio.Credentials.new().get_unix_user()),
            },
          ),
        }),
    });
    this._tabLoader = tabLoader;

    this._indicator = new RestoreIndicator(`${this.path}/icons/kitty-paw-symbolic.svg`, {
      activateWindow: (window, timestamp) => Main.activateWindow(window, timestamp),
      listWindows: () => tracker.listKittyWindows(),
      loadWindowDetails: (windows) => tabLoader.load(windows),
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
    this._tabLoader?.stop();
    this._tabLoader = null;
    this._controller?.stop();
    this._controller = null;
    this._indicator?.destroy();
    this._indicator = null;
  }
}
