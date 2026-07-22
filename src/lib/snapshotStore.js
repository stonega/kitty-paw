import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { MANIFEST_VERSION, SNAPSHOT_SLOTS, STATE_DIRECTORY_NAME } from './constants.js';
import { chooseInactiveSlot, validateManifest } from './policy.js';

const CURRENT_POINTER = 'current';
const MANIFEST_FILE = 'manifest.json';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function ensureDirectory(path) {
  if (GLib.mkdir_with_parents(path, PRIVATE_DIRECTORY_MODE) !== 0)
    throw new Error(`Could not create state directory: ${path}`);
  GLib.chmod(path, PRIVATE_DIRECTORY_MODE);
}

function readText(path) {
  try {
    const [ok, contents] = GLib.file_get_contents(path);
    return ok ? new TextDecoder().decode(contents) : null;
  } catch {
    return null;
  }
}

function writeText(path, contents) {
  if (!GLib.file_set_contents(path, contents))
    throw new Error(`Could not write state file: ${path}`);
  GLib.chmod(path, PRIVATE_FILE_MODE);
}

function writeTextAtomically(path, contents) {
  const temporaryPath = `${path}.tmp`;
  writeText(temporaryPath, contents);
  if (GLib.rename(temporaryPath, path) !== 0)
    throw new Error(`Could not publish state file: ${path}`);
  GLib.chmod(path, PRIVATE_FILE_MODE);
}

function removeTree(path) {
  const file = Gio.File.new_for_path(path);
  if (!file.query_exists(null)) return;

  const info = file.query_info('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);

  if (info.get_file_type() === Gio.FileType.DIRECTORY) {
    const enumerator = file.enumerate_children(
      'standard::name',
      Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
      null,
    );
    try {
      for (let child = enumerator.next_file(null); child; child = enumerator.next_file(null))
        removeTree(file.get_child(child.get_name()).get_path());
    } finally {
      enumerator.close(null);
    }
  }

  file.delete(null);
}

function assertSessionFile(path) {
  const file = Gio.File.new_for_path(path);
  const info = file.query_info(
    'standard::size,standard::type',
    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
    null,
  );
  if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() <= 0)
    throw new Error('Kitty produced an empty or invalid session file.');
  GLib.chmod(path, PRIVATE_FILE_MODE);
}

function sessionFilename(index) {
  return `instance-${String(index + 1).padStart(3, '0')}.session`;
}

export class SnapshotStore {
  constructor({ baseDirectory = null } = {}) {
    this.baseDirectory =
      baseDirectory ?? GLib.build_filenamev([GLib.get_user_state_dir(), STATE_DIRECTORY_NAME]);
  }

  async capture({ pids, reason, captureInstance }) {
    const orderedPids = [...new Set(pids)].sort((left, right) => left - right);
    if (orderedPids.length === 0) throw new Error('No Kitty instances are available to save.');

    ensureDirectory(this.baseDirectory);
    const activeSlot = this._readCurrentSlot();
    const targetSlot = chooseInactiveSlot(activeSlot);
    const targetDirectory = this._slotPath(targetSlot);

    removeTree(targetDirectory);
    ensureDirectory(targetDirectory);

    try {
      const instances = [];
      for (const [index, pid] of orderedPids.entries()) {
        const file = sessionFilename(index);
        const destination = GLib.build_filenamev([targetDirectory, file]);
        await captureInstance(pid, destination);
        assertSessionFile(destination);
        instances.push({ file, pid });
      }

      const manifest = {
        instances,
        reason,
        savedAt: new Date().toISOString(),
        version: MANIFEST_VERSION,
      };
      if (!validateManifest(manifest)) throw new Error('Generated snapshot manifest is invalid.');

      writeText(
        GLib.build_filenamev([targetDirectory, MANIFEST_FILE]),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      writeTextAtomically(
        GLib.build_filenamev([this.baseDirectory, CURRENT_POINTER]),
        `${targetSlot}\n`,
      );
      return { manifest, sessionPaths: this._sessionPaths(targetDirectory, manifest) };
    } catch (error) {
      removeTree(targetDirectory);
      throw error;
    }
  }

  loadCurrent() {
    const preferredSlot = this._readCurrentSlot();
    const candidates = preferredSlot
      ? [preferredSlot, ...SNAPSHOT_SLOTS.filter((slot) => slot !== preferredSlot)]
      : [...SNAPSHOT_SLOTS];

    for (const slot of candidates) {
      const snapshot = this._loadSlot(slot);
      if (snapshot) return snapshot;
    }
    return null;
  }

  _loadSlot(slot) {
    const directory = this._slotPath(slot);
    const text = readText(GLib.build_filenamev([directory, MANIFEST_FILE]));
    if (!text) return null;

    try {
      const manifest = JSON.parse(text);
      if (!validateManifest(manifest)) return null;
      const sessionPaths = this._sessionPaths(directory, manifest);
      for (const path of sessionPaths) assertSessionFile(path);
      return { manifest, sessionPaths };
    } catch {
      return null;
    }
  }

  _sessionPaths(directory, manifest) {
    return manifest.instances.map(({ file }) => GLib.build_filenamev([directory, file]));
  }

  _readCurrentSlot() {
    const current = readText(GLib.build_filenamev([this.baseDirectory, CURRENT_POINTER]))?.trim();
    return SNAPSHOT_SLOTS.includes(current) ? current : null;
  }

  _slotPath(slot) {
    return GLib.build_filenamev([this.baseDirectory, slot]);
  }
}
