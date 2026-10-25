#!/usr/bin/env bash
# WB use-case suite runner — the upstream-drift alarm for manim-web.
#
# Runs the WB use-case tests (src/wb-use-cases/*.test.ts) against a
# manim-web checkout. The suite sources always come from THIS script's
# repo (the graft repo, branch wb/stack-0.39.3) and are copied into the
# target checkout when it is a different one, so one command tests:
#   - the WB stack itself        (no argument: runs in place)
#   - the bare PR chain          (pass that checkout's path)
#   - a pristine upstream tree   (pass that checkout's path)
#
# Usage:
#   scripts/run-wb-use-cases.sh [TARGET_DIR]
#
# TARGET_DIR defaults to this script's own repo root. The target needs
# node_modules: if missing, this script symlinks the suite home's
# node_modules when available, else runs `npm ci`. No interactive
# steps; exit code is vitest's exit code. Expected results:
#   WB stack                    -> all pass (2 tests)
#   pristine upstream v0.40.1   -> both tests FAIL (they pin the
#                                  group-alignment fix). Suite pruned
#                                  2026-10-25: cases that pass on
#                                  pristine upstream were removed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$(cd "${1:-$SUITE_HOME}" && pwd)"
SUITE_REL="src/wb-use-cases"

if [ "$TARGET" != "$SUITE_HOME" ]; then
  mkdir -p "$TARGET/$SUITE_REL"
  cp "$SUITE_HOME/$SUITE_REL"/*.test.ts "$TARGET/$SUITE_REL/"
fi

if [ ! -d "$TARGET/node_modules" ]; then
  if [ -d "$SUITE_HOME/node_modules" ]; then
    ln -s "$SUITE_HOME/node_modules" "$TARGET/node_modules"
  else
    (cd "$TARGET" && npm ci --no-audit --no-fund)
  fi
fi

cd "$TARGET"
echo "WB use-case suite: target=$TARGET ref=$(git -C "$TARGET" rev-parse --short HEAD 2>/dev/null || echo unknown)"
npx vitest run "$SUITE_REL"
