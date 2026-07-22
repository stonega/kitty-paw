#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
glib-compile-schemas --strict --dry-run "${project_root}/src/schemas"
