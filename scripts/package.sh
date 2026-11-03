#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="${project_root}/src"
output_dir="${project_root}/dist"
bundle="${output_dir}/kitty-session-restorer@stone.dev.shell-extension.zip"

mkdir -p "${output_dir}"
gnome-extensions pack \
  --force \
  --out-dir="${output_dir}" \
  --schema="${source_dir}/schemas/org.gnome.shell.extensions.kitty-session-restorer.gschema.xml" \
  --extra-source="${source_dir}/icons" \
  --extra-source="${source_dir}/lib" \
  --extra-source="${source_dir}/LICENSE" \
  --extra-source="${source_dir}/THIRD_PARTY_NOTICES.md" \
  "${source_dir}"

test -s "${bundle}"
for required_file in metadata.json extension.js prefs.js stylesheet.css icons/kitty-paw-symbolic.svg lib/codexCommand.js lib/codexHookInstaller.js lib/codexHooks.js lib/codexSession.js lib/codexSessionHook.js LICENSE THIRD_PARTY_NOTICES.md; do
  unzip -Z1 "${bundle}" | grep -Fxq "${required_file}" || {
    echo "Package is missing ${required_file}" >&2
    exit 1
  }
done

echo "${bundle}"
