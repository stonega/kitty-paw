import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { EXTENSION_NAME, SETTINGS_KEYS } from './constants.js';
import { expandSocketTemplate, restoreDecision } from './policy.js';
import { prepareSavedSession } from './sessionFile.js';

const EVENT_DEBOUNCE_SECONDS = 2;
const ERROR_NOTIFICATION_COOLDOWN_SECONDS = 10 * 60;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function unixUserId() {
  try {
    return String(Gio.Credentials.new().get_unix_user());
  } catch {
    return '';
  }
}

export class SessionController {
  constructor({ settings, tracker, store, client, notify, onStatusChanged, logger = console }) {
    this._settings = settings;
    this._tracker = tracker;
    this._store = store;
    this._client = client;
    this._notify = notify;
    this._onStatusChanged = onStatusChanged;
    this._logger = logger;

    this._debounceId = 0;
    this._intervalId = 0;
    this._settingsSignals = [];
    this._cancellable = null;
    this._saving = false;
    this._restoring = false;
    this._pendingSave = false;
    this._pendingReason = 'pending';
    this._stopped = true;
    this._lastErrorMessage = '';
    this._lastErrorNotificationTime = 0;
  }

  start() {
    if (!this._stopped) return;
    this._cancellable = new Gio.Cancellable();
    this._stopped = false;
    this._tracker.start((reason) => this.requestSave(reason));

    this._settingsSignals.push(
      this._settings.connect(`changed::${SETTINGS_KEYS.autosaveInterval}`, () => {
        this._resetInterval();
        this.requestSave('settings-changed');
      }),
    );
    for (const key of [
      SETTINGS_KEYS.autoRunCommands,
      SETTINGS_KEYS.kittyCommand,
      SETTINGS_KEYS.kittenCommand,
      SETTINGS_KEYS.resumeForegroundProcesses,
      SETTINGS_KEYS.socketTemplate,
      SETTINGS_KEYS.windowIdentifiers,
    ]) {
      this._settingsSignals.push(
        this._settings.connect(`changed::${key}`, () => this.requestSave('settings-changed')),
      );
    }

    this._resetInterval();
    this.requestSave('extension-enabled');
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._removeSource('_debounceId');
    this._removeSource('_intervalId');
    for (const signalId of this._settingsSignals) this._settings.disconnect(signalId);
    this._settingsSignals = [];
    this._tracker.stop();
    this._cancellable.cancel();
    this._client.stop();
    this._pendingSave = false;
  }

  requestSave(reason, delaySeconds = EVENT_DEBOUNCE_SECONDS) {
    if (this._stopped) return;
    // An in-flight capture already services periodic ticks; only events need a retry.
    if (this._saving && reason === 'periodic') return;
    this._pendingReason = reason;
    if (this._saving) {
      this._pendingSave = true;
      return;
    }

    // Coalesce bursts without letting focus changes postpone a save indefinitely.
    if (this._debounceId) return;
    this._debounceId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      Math.max(1, delaySeconds),
      () => {
        this._debounceId = 0;
        void this._capture(this._pendingReason);
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  async restore() {
    if (this._stopped) return;

    const decision = restoreDecision({
      hasKittyWindows: this._tracker.hasKittyWindows(),
      hasSnapshot: true,
      isRestoring: this._restoring,
    });

    if (decision === 'busy') {
      this._notify(EXTENSION_NAME, 'A saved session is already being restored.');
      return;
    }
    if (decision === 'kitty-open') {
      this._notify(
        EXTENSION_NAME,
        'Kitty is already open. Close every Kitty window before restoring.',
      );
      return;
    }
    this._restoring = true;
    this._setStatus('restoring');
    try {
      const snapshot = await this._store.loadCurrent({ cancellable: this._cancellable });
      if (this._stopped) return;
      // Windows can appear while the snapshot is being read asynchronously.
      if (this._tracker.hasKittyWindows()) {
        this._notify(
          EXTENSION_NAME,
          'Kitty is already open. Close every Kitty window before restoring.',
        );
        this._setStatus('idle');
        return;
      }
      if (snapshot === null) {
        this._notify(EXTENSION_NAME, 'No saved Kitty session is available yet.');
        this._setStatus('idle');
        return;
      }
      const kittyCommand = this._settings.get_string(SETTINGS_KEYS.kittyCommand);
      for (const [index, sessionPath] of snapshot.sessionPaths.entries()) {
        if (this._stopped) return;
        const launch = () => this._client.launchSession({ kittyCommand, sessionPath });
        const workspaces = snapshot.manifest.instances[index].workspaces;
        if (workspaces === undefined) await launch();
        else await this._tracker.restoreWorkspaces({ launch, workspaces });
      }
      if (!this._stopped) {
        const count = snapshot.sessionPaths.length;
        this._notify(
          EXTENSION_NAME,
          `Restored ${count} saved Kitty ${count === 1 ? 'instance' : 'instances'}.`,
        );
        this._setStatus('idle');
      }
    } catch (error) {
      if (!this._stopped) {
        this._logger.error(`[${EXTENSION_NAME}] Restore failed: ${errorMessage(error)}`);
        this._notify(EXTENSION_NAME, `Could not restore Kitty: ${errorMessage(error)}`);
        this._setStatus('error');
      }
    } finally {
      this._restoring = false;
    }
  }

  async _capture(reason) {
    if (this._stopped || this._saving) return;
    const instances = this._tracker.kittyInstances();
    if (instances.length === 0) return;

    this._saving = true;
    this._setStatus('saving');
    try {
      const kittenCommand = this._settings.get_string(SETTINGS_KEYS.kittenCommand);
      const socketTemplate = this._settings.get_string(SETTINGS_KEYS.socketTemplate);
      const resumeForegroundProcesses = this._settings.get_boolean(
        SETTINGS_KEYS.resumeForegroundProcesses,
      );
      const autoRunCommands = this._settings.get_strv(SETTINGS_KEYS.autoRunCommands);
      const environment = {
        runtimeDir: GLib.get_user_runtime_dir(),
        uid: unixUserId(),
      };

      await this._store.capture({
        cancellable: this._cancellable,
        captureInstance: async (pid, destination) => {
          const socketAddress = expandSocketTemplate(socketTemplate, pid, environment);
          await this._client.saveSession({
            destination,
            kittenCommand,
            socketAddress,
            useForegroundProcesses: resumeForegroundProcesses,
          });
        },
        instances,
        processSession: resumeForegroundProcesses
          ? (sessionContents) => prepareSavedSession(sessionContents, autoRunCommands)
          : null,
        reason,
      });

      if (!this._stopped) {
        this._lastErrorMessage = '';
        this._setStatus('idle');
      }
    } catch (error) {
      if (!this._stopped) {
        const message = errorMessage(error);
        this._logger.error(`[${EXTENSION_NAME}] Snapshot failed: ${message}`);
        this._notifySaveError(message);
        this._setStatus('error');
      }
    } finally {
      this._saving = false;
      if (this._pendingSave && !this._stopped) {
        this._pendingSave = false;
        this.requestSave(this._pendingReason, 1);
      }
    }
  }

  _notifySaveError(message) {
    const now = GLib.get_monotonic_time() / GLib.USEC_PER_SEC;
    const messageChanged = message !== this._lastErrorMessage;
    const cooldownExpired =
      now - this._lastErrorNotificationTime >= ERROR_NOTIFICATION_COOLDOWN_SECONDS;
    if (messageChanged || cooldownExpired) {
      this._notify(EXTENSION_NAME, `Could not save Kitty: ${message}`);
      this._lastErrorNotificationTime = now;
    }
    this._lastErrorMessage = message;
  }

  _resetInterval() {
    this._removeSource('_intervalId');
    if (this._stopped) return;

    const interval = this._settings.get_uint(SETTINGS_KEYS.autosaveInterval);
    this._intervalId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
      this.requestSave('periodic', 1);
      return GLib.SOURCE_CONTINUE;
    });
  }

  _removeSource(property) {
    if (this[property]) {
      GLib.Source.remove(this[property]);
      this[property] = 0;
    }
  }

  _setStatus(status) {
    this._onStatusChanged?.(status);
  }
}
