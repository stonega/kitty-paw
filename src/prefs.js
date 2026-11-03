import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { codexHookStatus, installCodexHooks } from './lib/codexHookInstaller.js';
import { SETTINGS_KEYS } from './lib/constants.js';
import { normalizeAutoRunCommands } from './lib/sessionFile.js';

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
      description: 'Session structure, working directories, and GNOME workspaces are always saved.',
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

    const foregroundRow = new Adw.SwitchRow({
      subtitle:
        'Only commands in the allowlist below may run. Other windows reopen with a normal shell.',
      title: 'Restart allowed foreground programs',
    });
    settings.bind(
      SETTINGS_KEYS.resumeForegroundProcesses,
      foregroundRow,
      'active',
      Gio.SettingsBindFlags.DEFAULT,
    );
    savingGroup.add(foregroundRow);

    const allowlistGroup = new Adw.PreferencesGroup({
      description:
        'Add executable names such as codex or nvim, or exact absolute paths. Arguments are preserved from the saved session.',
      title: 'Auto-run command allowlist',
    });
    page.add(allowlistGroup);

    const addCommandRow = new Adw.EntryRow({
      title: 'Executable name or absolute path',
    });
    const addCommandButton = new Gtk.Button({
      icon_name: 'list-add-symbolic',
      tooltip_text: 'Add command',
      valign: Gtk.Align.CENTER,
    });
    addCommandRow.add_suffix(addCommandButton);

    let commandRows = [];
    let addCommandRowAttached = false;
    const rebuildCommandRows = () => {
      for (const row of commandRows) allowlistGroup.remove(row);
      commandRows = [];
      if (addCommandRowAttached) allowlistGroup.remove(addCommandRow);

      for (const command of normalizeAutoRunCommands(
        settings.get_strv(SETTINGS_KEYS.autoRunCommands),
      )) {
        const row = new Adw.ActionRow({
          subtitle: command.includes('/')
            ? 'Only this exact executable path may restart.'
            : `Matches ${command} at any executable path.`,
          title: command,
        });
        row.add_prefix(new Gtk.Image({ icon_name: 'system-run-symbolic' }));
        const removeButton = new Gtk.Button({
          icon_name: 'list-remove-symbolic',
          tooltip_text: `Remove ${command}`,
          valign: Gtk.Align.CENTER,
        });
        removeButton.add_css_class('flat');
        removeButton.connect('clicked', () => {
          const updated = normalizeAutoRunCommands(
            settings.get_strv(SETTINGS_KEYS.autoRunCommands),
          ).filter((candidate) => candidate !== command);
          settings.set_strv(SETTINGS_KEYS.autoRunCommands, updated);
        });
        row.add_suffix(removeButton);
        commandRows.push(row);
        allowlistGroup.add(row);
      }
      allowlistGroup.add(addCommandRow);
      addCommandRowAttached = true;
    };

    const addCommand = () => {
      const command = addCommandRow.text.trim();
      if (!command || command.includes('\0')) return;
      const updated = normalizeAutoRunCommands([
        ...settings.get_strv(SETTINGS_KEYS.autoRunCommands),
        command,
      ]);
      settings.set_strv(SETTINGS_KEYS.autoRunCommands, updated);
      addCommandRow.text = '';
    };
    addCommandButton.connect('clicked', addCommand);
    settings.connect(`changed::${SETTINGS_KEYS.autoRunCommands}`, rebuildCommandRows);
    rebuildCommandRows();

    const codexGroup = new Adw.PreferencesGroup({
      description:
        'Start Codex with --no-daemon for exact per-tab recovery. Shared or remote app servers cannot identify the calling Kitty window.',
      title: 'Codex CLI integration',
    });
    page.add(codexGroup);

    const codexHookRow = new Adw.ActionRow({
      title: 'Exact per-tab Codex resume',
    });
    codexHookRow.add_prefix(new Gtk.Image({ icon_name: 'utilities-terminal-symbolic' }));
    const codexHookButton = new Gtk.Button({
      label: 'Install / Update Hooks',
      valign: Gtk.Align.CENTER,
    });
    codexHookRow.add_suffix(codexHookButton);
    codexHookRow.activatable_widget = codexHookButton;
    codexGroup.add(codexHookRow);

    const refreshCodexHookStatus = () => {
      const status = codexHookStatus();
      codexHookRow.subtitle = status.detail;
      codexHookButton.label = status.configured ? 'Update Hooks' : 'Install Hooks';
    };
    codexHookButton.connect('clicked', () => {
      try {
        installCodexHooks();
        refreshCodexHookStatus();
      } catch (error) {
        codexHookRow.subtitle = `Could not configure hooks: ${error.message ?? String(error)}`;
      }
    });
    refreshCodexHookStatus();
  }
}
