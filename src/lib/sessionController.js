import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { EXTENSION_NAME, SETTINGS_KEYS } from './constants.js';
import { expandSocketTemplate, restoreDecision } from './policy.js';

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
    this._stopped = false;
    this._tracker.start((reason) => this.requestSave(reason));

    this._settingsSignals.push(
      this._settings.connect(`changed::${SETTINGS_KEYS.autosaveInterval}`, () => {
        this._resetInterval();
        this.requestSave('settings-changed');
      }),
    );
    for (const key of [
      SETTINGS_KEYS.kittyCommand,
      SETTINGS_KEYS.kittenCommand,
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
    this._client.stop();
    this._pendingSave = false;
  }

  requestSave(reason, delaySeconds = EVENT_DEBOUNCE_SECONDS) {
    if (this._stopped) return;
    this._pendingReason = reason;
    if (this._saving) {
      this._pendingSave = true;
      return;
    }

    this._removeSource('_debounceId');
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

    const snapshot = this._store.loadCurrent();
    const decision = restoreDecision({
      hasKittyWindows: this._tracker.hasKittyWindows(),
      hasSnapshot: snapshot !== null,
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
    if (decision === 'no-snapshot') {
      this._notify(EXTENSION_NAME, 'No saved Kitty session is available yet.');
      return;
    }

    this._restoring = true;
    this._setStatus('restoring');
    try {
      const kittyCommand = this._settings.get_string(SETTINGS_KEYS.kittyCommand);
      for (const sessionPath of snapshot.sessionPaths) {
        if (this._stopped) return;
        await this._client.launchSession({ kittyCommand, sessionPath });
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
    const pids = this._tracker.kittyPids();
    if (pids.length === 0) return;

    this._saving = true;
    this._setStatus('saving');
    try {
      const kittenCommand = this._settings.get_string(SETTINGS_KEYS.kittenCommand);
      const socketTemplate = this._settings.get_string(SETTINGS_KEYS.socketTemplate);
      const environment = {
        runtimeDir: GLib.get_user_runtime_dir(),
        uid: unixUserId(),
      };

      await this._store.capture({
        captureInstance: async (pid, destination) => {
          const socketAddress = expandSocketTemplate(socketTemplate, pid, environment);
          await this._client.saveSession({
            destination,
            kittenCommand,
            socketAddress,
          });
        },
        pids,
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
