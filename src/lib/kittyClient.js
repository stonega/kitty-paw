import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const DEFAULT_TIMEOUT_SECONDS = 10;
const MAX_ERROR_LENGTH = 500;

function executablePath(command) {
  const candidate = command.trim();
  if (!candidate) throw new Error('An executable name or path is required.');
  if (candidate.includes('\0')) throw new Error('The executable contains an invalid NUL byte.');

  if (candidate.includes('/')) {
    const path = GLib.canonicalize_filename(candidate, null);
    if (!GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
      throw new Error(`Executable is not available: ${path}`);
    return path;
  }

  const path = GLib.find_program_in_path(candidate);
  if (!path) throw new Error(`Executable was not found on GNOME Shell's PATH: ${candidate}`);
  return path;
}

function conciseError(stderr, fallback) {
  const message = stderr.trim() || fallback;
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

export class KittyClient {
  constructor({ timeoutSeconds = DEFAULT_TIMEOUT_SECONDS } = {}) {
    this._timeoutSeconds = timeoutSeconds;
    this._operations = new Set();
    this._stopped = false;
  }

  async saveSession({ kittenCommand, socketAddress, destination, useForegroundProcesses = false }) {
    const executable = executablePath(kittenCommand);
    const argv = [
      executable,
      '@',
      '--to',
      socketAddress,
      'action',
      'save_as_session',
      '--save-only',
    ];
    if (useForegroundProcesses) argv.push('--use-foreground-process');
    argv.push(destination);
    await this._run(argv);
  }

  async launchSession({ kittyCommand, sessionPath }) {
    const executable = executablePath(kittyCommand);
    await this._run([executable, '--detach', '--session', sessionPath]);
  }

  stop() {
    this._stopped = true;
    for (const operation of this._operations) {
      operation.cancellable.cancel();
      try {
        operation.process.force_exit();
      } catch {
        // The process may have exited between cancellation and force_exit().
      }
    }
    this._operations.clear();
  }

  async _run(argv) {
    if (this._stopped) throw new Error('Kitty command execution has stopped.');

    const flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
    const process = Gio.Subprocess.new(argv, flags);
    const cancellable = new Gio.Cancellable();
    const operation = { cancellable, process };
    this._operations.add(operation);

    let timedOut = false;
    const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._timeoutSeconds, () => {
      timedOut = true;
      cancellable.cancel();
      try {
        process.force_exit();
      } catch {
        // The process completed as the timeout fired.
      }
      return GLib.SOURCE_REMOVE;
    });

    try {
      const [stdout, stderr] = await process.communicate_utf8_async(null, cancellable);
      if (!process.get_successful()) {
        const status = process.get_exit_status();
        throw new Error(conciseError(stderr, `${argv[0]} exited with status ${status}.`));
      }
      return { stderr, stdout };
    } catch (error) {
      if (timedOut)
        throw new Error(`${argv[0]} did not finish within ${this._timeoutSeconds} seconds.`);
      throw error;
    } finally {
      if (!timedOut) GLib.Source.remove(timeoutId);
      this._operations.delete(operation);
    }
  }
}
