#!/bin/sh
# Diagnostic fallback: this opens Terminal. Normal Finder entry is PaperEcho.app.
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
exec "$repo_root/PaperEcho.app/Contents/MacOS/PaperEcho" "$@"
