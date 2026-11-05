import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { MANIFEST_VERSION, SNAPSHOT_SLOTS, STATE_DIRECTORY_NAME } from './constants.js';
import { chooseInactiveSlot, validateManifest, validateWorkspaceAssignments } from './policy.js';

for (const method of [
  'delete_async',
  'enumerate_children_async',
  'load_contents_async',
  'make_directory_async',
  'query_info_async',
  'set_attributes_async',
])
  Gio._promisify(Gio.File.prototype, method);
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

const CURRENT_POINTER = 'current';
const MANIFEST_FILE = 'manifest.json';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const IO_PRIORITY = GLib.PRIORITY_DEFAULT;
const NOFOLLOW = Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS;

async function setMode(file, mode, cancellable) {
  const attributes = new Gio.FileInfo();
  attributes.set_attribute_uint32('unix::mode', mode);
  await file.set_attributes_async(attributes, NOFOLLOW, IO_PRIORITY, cancellable);
}

async function makeDirectory(file, cancellable) {
  try {
    await file.make_directory_async(IO_PRIORITY, cancellable);
  } catch (error) {
    if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) return;
    const parent = file.get_parent();
    if (!parent || !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) throw error;
    await makeDirectory(parent, cancellable);
    await file.make_directory_async(IO_PRIORITY, cancellable);
  }
}

async function ensureDirectory(path, cancellable) {
  const file = Gio.File.new_for_path(path);
  await makeDirectory(file, cancellable);
  await setMode(file, PRIVATE_DIRECTORY_MODE, cancellable);
}

async function readText(path, cancellable) {
  try {
    const [contents] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
    return new TextDecoder().decode(contents);
  } catch (error) {
    if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) throw error;
    return null;
  }
}

async function writeText(path, contents, cancellable) {
  // GBytes owns the buffer until Gio finishes the asynchronous, atomic replacement.
  await Gio.File.new_for_path(path).replace_contents_bytes_async(
    new GLib.Bytes(new TextEncoder().encode(contents)),
    null,
    false,
    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
    cancellable,
  );
}

async function removeTree(path, cancellable) {
  const file = Gio.File.new_for_path(path);
  let info;
  try {
    info = await file.query_info_async('standard::type', NOFOLLOW, IO_PRIORITY, cancellable);
  } catch (error) {
    if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) return;
    throw error;
  }

  if (info.get_file_type() === Gio.FileType.DIRECTORY) {
    const enumerator = await file.enumerate_children_async(
      'standard::name',
      NOFOLLOW,
      IO_PRIORITY,
      cancellable,
    );
    try {
      let children;
      do {
        children = await enumerator.next_files_async(32, IO_PRIORITY, cancellable);
        for (const child of children)
          await removeTree(file.get_child(child.get_name()).get_path(), cancellable);
      } while (children.length > 0);
    } finally {
      // Even a cancelled traversal must close its enumerator.
      await enumerator.close_async(IO_PRIORITY, null);
    }
  }

  await file.delete_async(IO_PRIORITY, cancellable);
}

async function assertSessionFile(path, cancellable, secure = false) {
  const file = Gio.File.new_for_path(path);
  const info = await file.query_info_async(
    'standard::size,standard::type',
    NOFOLLOW,
    IO_PRIORITY,
    cancellable,
  );
  if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() <= 0)
    throw new Error('Kitty produced an empty or invalid session file.');
  if (secure) await setMode(file, PRIVATE_FILE_MODE, cancellable);
}

function sessionFilename(index) {
  return `instance-${String(index + 1).padStart(3, '0')}.session`;
}

function normalizeInstances(instances) {
  if (!Array.isArray(instances))
    throw new Error('Kitty capture instances must be provided as an array.');

  const uniqueInstances = new Map();
  for (const instance of instances) {
    if (!instance || !Number.isSafeInteger(instance.pid) || instance.pid <= 0)
      throw new Error('Kitty instance PIDs must be positive integers.');
    if (instance.workspaces !== undefined && !validateWorkspaceAssignments(instance.workspaces))
      throw new Error('Kitty workspace assignments are invalid.');
    if (!uniqueInstances.has(instance.pid)) {
      uniqueInstances.set(instance.pid, {
        pid: instance.pid,
        ...(instance.workspaces === undefined ? {} : { workspaces: [...instance.workspaces] }),
      });
    }
  }

  return [...uniqueInstances.values()].sort((left, right) => left.pid - right.pid);
}

export class SnapshotStore {
  constructor({ baseDirectory = null } = {}) {
    this.baseDirectory =
      baseDirectory ?? GLib.build_filenamev([GLib.get_user_state_dir(), STATE_DIRECTORY_NAME]);
  }

  async capture({
    instances: captureInstances,
    reason,
    captureInstance,
    processSession = null,
    cancellable = null,
  }) {
    const orderedInstances = normalizeInstances(captureInstances);
    if (orderedInstances.length === 0) throw new Error('No Kitty instances are available to save.');

    await ensureDirectory(this.baseDirectory, cancellable);
    const activeSlot = await this._readCurrentSlot(cancellable);
    const targetSlot = chooseInactiveSlot(activeSlot);
    const targetDirectory = this._slotPath(targetSlot);

    await removeTree(targetDirectory, cancellable);
    await ensureDirectory(targetDirectory, cancellable);

    try {
      const instances = [];
      for (const [index, instance] of orderedInstances.entries()) {
        const file = sessionFilename(index);
        const destination = GLib.build_filenamev([targetDirectory, file]);
        await captureInstance(instance.pid, destination);
        await assertSessionFile(destination, cancellable, true);
        if (processSession) {
          const sessionContents = await readText(destination, cancellable);
          if (sessionContents === null) throw new Error('Could not read saved Kitty session.');
          const processedContents = await processSession(sessionContents, instance);
          if (typeof processedContents !== 'string')
            throw new Error('Kitty session processing produced invalid output.');
          if (processedContents.length === 0)
            throw new Error('Kitty produced an empty or invalid session file.');
          if (processedContents !== sessionContents)
            await writeText(destination, processedContents, cancellable);
        }
        instances.push({ file, ...instance });
      }

      const manifest = {
        instances,
        reason,
        savedAt: new Date().toISOString(),
        version: MANIFEST_VERSION,
      };
      if (!validateManifest(manifest)) throw new Error('Generated snapshot manifest is invalid.');

      await writeText(
        GLib.build_filenamev([targetDirectory, MANIFEST_FILE]),
        `${JSON.stringify(manifest, null, 2)}\n`,
        cancellable,
      );
      await writeText(
        GLib.build_filenamev([this.baseDirectory, CURRENT_POINTER]),
        `${targetSlot}\n`,
        cancellable,
      );
      return { manifest, sessionPaths: this._sessionPaths(targetDirectory, manifest) };
    } catch (error) {
      // Leave cancelled work in the inactive slot for the next capture to clean up.
      if (!cancellable?.is_cancelled()) {
        try {
          await removeTree(targetDirectory, cancellable);
        } catch {
          // Preserve the capture error if cleanup also fails.
        }
      }
      throw error;
    }
  }

  async loadCurrent({ cancellable = null } = {}) {
    const preferredSlot = await this._readCurrentSlot(cancellable);
    const candidates = preferredSlot
      ? [preferredSlot, ...SNAPSHOT_SLOTS.filter((slot) => slot !== preferredSlot)]
      : [...SNAPSHOT_SLOTS];

    for (const slot of candidates) {
      const snapshot = await this._loadSlot(slot, cancellable);
      if (snapshot) return snapshot;
    }
    return null;
  }

  async _loadSlot(slot, cancellable) {
    const directory = this._slotPath(slot);
    const text = await readText(GLib.build_filenamev([directory, MANIFEST_FILE]), cancellable);
    if (!text) return null;

    try {
      const manifest = JSON.parse(text);
      if (!validateManifest(manifest)) return null;
      const sessionPaths = this._sessionPaths(directory, manifest);
      for (const path of sessionPaths) await assertSessionFile(path, cancellable);
      return { manifest, sessionPaths };
    } catch (error) {
      if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) throw error;
      return null;
    }
  }

  _sessionPaths(directory, manifest) {
    return manifest.instances.map(({ file }) => GLib.build_filenamev([directory, file]));
  }

  async _readCurrentSlot(cancellable) {
    const current = (
      await readText(GLib.build_filenamev([this.baseDirectory, CURRENT_POINTER]), cancellable)
    )?.trim();
    return SNAPSHOT_SLOTS.includes(current) ? current : null;
  }

  _slotPath(slot) {
    return GLib.build_filenamev([this.baseDirectory, slot]);
  }
}
