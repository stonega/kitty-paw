import GLib from 'gi://GLib';

import { hasConfiguredCodexHooks, mergeCodexHooksConfig } from './codexHooks.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function hooksPath(codexDirectory) {
  return GLib.build_filenamev([codexDirectory, 'hooks.json']);
}

function readConfig(path) {
  if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return {};
  const [ok, contents] = GLib.file_get_contents(path);
  if (!ok) throw new Error(`Could not read ${path}.`);
  try {
    return JSON.parse(new TextDecoder().decode(contents));
  } catch {
    throw new Error(`${path} does not contain valid JSON.`);
  }
}

function writeConfigAtomically(path, config) {
  const temporaryPath = `${path}.tmp-${GLib.get_monotonic_time()}`;
  try {
    const contents = `${JSON.stringify(config, null, 2)}\n`;
    if (!GLib.file_set_contents(temporaryPath, contents))
      throw new Error(`Could not write ${temporaryPath}.`);
    GLib.chmod(temporaryPath, PRIVATE_FILE_MODE);
    if (GLib.rename(temporaryPath, path) !== 0) throw new Error(`Could not publish ${path}.`);
    GLib.chmod(path, PRIVATE_FILE_MODE);
  } finally {
    if (GLib.file_test(temporaryPath, GLib.FileTest.EXISTS)) GLib.unlink(temporaryPath);
  }
}

export function defaultCodexDirectory() {
  const configured = GLib.getenv('CODEX_HOME');
  return configured
    ? GLib.canonicalize_filename(configured, null)
    : GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
}

export function codexHookStatus(codexDirectory = defaultCodexDirectory()) {
  const path = hooksPath(codexDirectory);
  try {
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
      return { configured: false, detail: 'Hooks are not configured.' };
    return hasConfiguredCodexHooks(readConfig(path))
      ? { configured: true, detail: 'Hooks are configured. Trust them from /hooks in Codex.' }
      : { configured: false, detail: 'Kitty session hooks are not configured.' };
  } catch (error) {
    return { configured: false, detail: error.message ?? String(error) };
  }
}

export function installCodexHooks(codexDirectory = defaultCodexDirectory()) {
  if (GLib.mkdir_with_parents(codexDirectory, PRIVATE_DIRECTORY_MODE) !== 0)
    throw new Error(`Could not create ${codexDirectory}.`);

  const path = hooksPath(codexDirectory);
  const config = mergeCodexHooksConfig(readConfig(path));
  writeConfigAtomically(path, config);
  return path;
}
