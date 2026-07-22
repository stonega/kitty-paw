export const EXTENSION_UUID = 'kitty-session-restorer@stone.dev';
export const EXTENSION_NAME = 'Kitty Session Restorer';
export const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.kitty-session-restorer';
export const STATE_DIRECTORY_NAME = 'kitty-session-restorer';
export const MANIFEST_VERSION = 1;

export const SETTINGS_KEYS = Object.freeze({
  autosaveInterval: 'autosave-interval-seconds',
  kittyCommand: 'kitty-command',
  kittenCommand: 'kitten-command',
  socketTemplate: 'socket-template',
  windowIdentifiers: 'kitty-window-identifiers',
});

export const SNAPSHOT_SLOTS = Object.freeze(['slot-a', 'slot-b']);
