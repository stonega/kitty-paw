#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle="${project_root}/dist/kitty-session-restorer@stone.dev.shell-extension.zip"

"${project_root}/scripts/package.sh" >/dev/null
uuid="$(gnome-extensions install --force --print-uuid "${bundle}")"

if gnome-extensions enable "${uuid}"; then
  echo "Installed and enabled ${uuid}."
else
  echo "Installed ${uuid}. Log out and back in, then enable it with: gnome-extensions enable ${uuid}"
fi
