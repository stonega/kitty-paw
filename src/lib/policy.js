import { MANIFEST_VERSION, SNAPSHOT_SLOTS } from './constants.js';

const SESSION_FILE_PATTERN = /^instance-\d{3}\.session$/;

export function normalizeIdentifier(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function matchesKittyWindow(window, identifiers) {
  const accepted = new Set(identifiers.map(normalizeIdentifier).filter(Boolean));
  if (accepted.size === 0) return false;

  return [window.appId, window.wmClass, window.wmClassInstance]
    .map(normalizeIdentifier)
    .some((identifier) => accepted.has(identifier));
}

export function collectKittyPids(windows, identifiers) {
  const pids = new Set();

  for (const window of windows) {
    if (
      matchesKittyWindow(window, identifiers) &&
      Number.isSafeInteger(window.pid) &&
      window.pid > 0
    )
      pids.add(window.pid);
  }

  return [...pids].sort((left, right) => left - right);
}

export function expandSocketTemplate(template, pid, environment = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('Kitty PID must be a positive integer.');
  if (typeof template !== 'string' || !template.includes('{pid}'))
    throw new Error('The socket template must contain {pid}.');
  if (template.includes('\0')) throw new Error('The socket template contains an invalid NUL byte.');

  const expanded = template
    .replaceAll('{pid}', String(pid))
    .replaceAll('{runtimeDir}', environment.runtimeDir ?? '')
    .replaceAll('{uid}', environment.uid ?? '');

  if (!expanded.startsWith('unix:') && !expanded.startsWith('tcp:'))
    throw new Error('The socket template must produce a unix: or tcp: address.');

  return expanded;
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false;
  if (manifest.version !== MANIFEST_VERSION) return false;
  if (typeof manifest.savedAt !== 'string' || Number.isNaN(Date.parse(manifest.savedAt)))
    return false;
  if (typeof manifest.reason !== 'string') return false;
  if (!Array.isArray(manifest.instances) || manifest.instances.length === 0) return false;

  const files = new Set();
  for (const instance of manifest.instances) {
    if (!instance || typeof instance !== 'object') return false;
    if (!Number.isSafeInteger(instance.pid) || instance.pid <= 0) return false;
    if (typeof instance.file !== 'string' || !SESSION_FILE_PATTERN.test(instance.file))
      return false;
    if (files.has(instance.file)) return false;
    files.add(instance.file);
  }

  return true;
}

export function chooseInactiveSlot(activeSlot) {
  return activeSlot === SNAPSHOT_SLOTS[0] ? SNAPSHOT_SLOTS[1] : SNAPSHOT_SLOTS[0];
}

export function restoreDecision({ hasKittyWindows, hasSnapshot, isRestoring }) {
  if (isRestoring) return 'busy';
  if (hasKittyWindows) return 'kitty-open';
  if (!hasSnapshot) return 'no-snapshot';
  return 'ready';
}
