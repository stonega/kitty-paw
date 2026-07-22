import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { SETTINGS_KEYS } from './lib/constants.js';

function addEntry(group, settings, key, title, subtitle) {
  const row = new Adw.EntryRow({ title });
  row.add_suffix(new Gtk.Image({ icon_name: 'document-edit-symbolic', tooltip_text: subtitle }));
  settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
  group.add(row);
  return row;
}

export default class KittySessionRestorerPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    window.set_default_size(680, 520);
    window.search_enabled = true;

    const page = new Adw.PreferencesPage({
      icon_name: 'utilities-terminal-symbolic',
      title: 'Kitty Session Restorer',
    });
    window.add(page);

    const savingGroup = new Adw.PreferencesGroup({
      description:
        'Session structure and working directories are saved. Foreground programs are not restarted.',
      title: 'Session saving',
    });
    page.add(savingGroup);

    const adjustment = new Gtk.Adjustment({
      lower: 5,
      page_increment: 30,
      step_increment: 5,
      upper: 300,
      value: settings.get_uint(SETTINGS_KEYS.autosaveInterval),
    });
    const intervalRow = new Adw.SpinRow({
      adjustment,
      digits: 0,
      subtitle: 'The latest snapshot may be this many seconds old if Kitty exits immediately.',
      title: 'Autosave interval (seconds)',
    });
    intervalRow.connect('notify::value', () => {
      settings.set_uint(SETTINGS_KEYS.autosaveInterval, Math.round(intervalRow.value));
    });
    settings.connect(`changed::${SETTINGS_KEYS.autosaveInterval}`, () => {
      const value = settings.get_uint(SETTINGS_KEYS.autosaveInterval);
      if (intervalRow.value !== value) intervalRow.value = value;
    });
    savingGroup.add(intervalRow);

    const commandsGroup = new Adw.PreferencesGroup({
      description: 'Use an executable name on GNOME Shell’s PATH or an absolute path.',
      title: 'Commands',
    });
    page.add(commandsGroup);
    addEntry(
      commandsGroup,
      settings,
      SETTINGS_KEYS.kittyCommand,
      'Kitty executable',
      'Used to launch a saved session.',
    );
    addEntry(
      commandsGroup,
      settings,
      SETTINGS_KEYS.kittenCommand,
      'Kitten executable',
      'Used to request a session snapshot over Kitty remote control.',
    );

    const detectionGroup = new Adw.PreferencesGroup({
      description:
        'The socket template must include {pid}. It may also include {runtimeDir} and {uid}.',
      title: 'Kitty detection and remote control',
    });
    page.add(detectionGroup);
    addEntry(
      detectionGroup,
      settings,
      SETTINGS_KEYS.socketTemplate,
      'Socket template',
      'Default: unix:/tmp/kitty-{pid}',
    );

    const identifiersRow = new Adw.EntryRow({ title: 'Window identifiers' });
    identifiersRow.text = settings.get_strv(SETTINGS_KEYS.windowIdentifiers).join(', ');
    identifiersRow.connect('changed', () => {
      const identifiers = identifiersRow.text
        .split(',')
        .map((identifier) => identifier.trim())
        .filter(Boolean);
      settings.set_strv(SETTINGS_KEYS.windowIdentifiers, identifiers);
    });
    detectionGroup.add(identifiersRow);

    const securityRow = new Adw.ActionRow({
      subtitle: 'Recommended Kitty setting: allow_remote_control socket-only',
      title: 'Use socket-only remote control',
    });
    securityRow.add_prefix(new Gtk.Image({ icon_name: 'security-high-symbolic' }));
    detectionGroup.add(securityRow);
  }
}
