import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};

let indicatorFound = false;

export async function run() {
  await Scripting.sleep(1000);
  const indicator = Main.panel.statusArea['kitty-session-restorer@stone.dev'];
  if (!indicator) throw new Error('Kitty Session Restorer did not register a panel indicator.');
  if (!indicator.visible) throw new Error('Kitty Session Restorer panel indicator is not visible.');
  if (!indicator.get_first_child())
    throw new Error('Kitty Session Restorer panel icon is missing.');
  indicatorFound = true;
  await Scripting.waitLeisure();
}

export function finish() {
  if (!indicatorFound) throw new Error('Kitty Session Restorer smoke test did not complete.');
}
