import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { EXTENSION_NAME } from './lib/constants.js';
import { KittyClient } from './lib/kittyClient.js';
import { SessionController } from './lib/sessionController.js';
import { SnapshotStore } from './lib/snapshotStore.js';
import { KittyWindowTracker } from './lib/windowTracker.js';

class RestoreIndicator extends PanelMenu.Button {
  static {
    GObject.registerClass(RestoreIndicator);
  }

  constructor(iconPath, onActivate) {
    super(0, EXTENSION_NAME, true);
    this.accessible_role = Atk.Role.PUSH_BUTTON;

    const iconFile = Gio.File.new_for_path(iconPath);
    this._icon = new St.Icon({
      gicon: new Gio.FileIcon({ file: iconFile }),
      style_class: 'system-status-icon',
    });
    this.add_child(this._icon);

    this.connect('button-release-event', (_actor, event) => {
      if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
      onActivate();
      return Clutter.EVENT_STOP;
    });
    this.connect('key-press-event', (_actor, event) => {
      const symbol = event.get_key_symbol();
      if (
        symbol !== Clutter.KEY_Return &&
        symbol !== Clutter.KEY_KP_Enter &&
        symbol !== Clutter.KEY_space
      )
        return Clutter.EVENT_PROPAGATE;
      onActivate();
      return Clutter.EVENT_STOP;
    });
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

    this._indicator = new RestoreIndicator(
      `${this.path}/icons/kitty-paw-symbolic.svg`,
      () => void this._controller?.restore(),
    );
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
