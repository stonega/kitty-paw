#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle="${project_root}/dist/kitty-session-restorer@stone.dev.shell-extension.zip"

"${project_root}/scripts/package.sh" >/dev/null
dbus-run-session -- gnome-shell-test-tool \
  --headless \
  --disable-animations \
  --extension="${bundle}" \
  "${project_root}/tests/gnome/smoke.js"
