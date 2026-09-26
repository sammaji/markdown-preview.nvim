#!/usr/bin/env bash
# Runs every automated test before a release:
#   server  cargo test: unit tests of src/ and the stdio protocol of the binary
#   page    vitest in app/: the markdown renderer, connection and sync scroll
#   e2e     playwright in e2e/: Neovim and Vim drive the release binary and a
#           browser checks the preview; install and release checks
#   docs    builds the documentation site in docs/, which fails on broken MDX
# Runs every suite even when one fails, and exits non-zero if any failed.
#
#   ./test.sh                 all suites
#   ./test.sh e2e             one suite (server, page, e2e or docs)
#   ./test.sh e2e -g Toggle   extra arguments go to that suite's runner

set -uo pipefail
[ "${TRACE:-}" ] && set -x

cd "$(dirname "$0")"
root=$(pwd)

for tool in cargo pnpm nvim vim; do
  command -v "$tool" >/dev/null || { echo "$tool not found on PATH" >&2; exit 1; }
done

only=${1:-}
[ $# -gt 0 ] && shift
case "$only" in
  "" | server | page | e2e | docs) ;;
  *) echo "unknown suite '$only', expected server, page, e2e or docs" >&2; exit 2 ;;
esac

failed=()

suite() {
  local name=$1
  shift
  [ -n "$only" ] && [ "$only" != "$name" ] && return
  echo
  echo "=== $name ==="
  if ! "$@"; then
    failed+=("$name")
  fi
}

server() (
  cargo test --locked "$@"
)

page() (
  cd "$root/app" &&
    pnpm install --frozen-lockfile &&
    pnpm typecheck &&
    pnpm test "$@"
)

e2e() (
  cd "$root/e2e" &&
    pnpm install --frozen-lockfile &&
    pnpm exec playwright install ${CI:+--with-deps} chromium &&
    pnpm typecheck &&
    pnpm test "$@"
)

docs() (
  cd "$root/docs" &&
    pnpm install --frozen-lockfile &&
    pnpm typecheck &&
    pnpm build "$@"
)

suite server server "$@"
suite page page "$@"
suite e2e e2e "$@"
suite docs docs "$@"

echo
if [ ${#failed[@]} -gt 0 ]; then
  echo "FAILED: ${failed[*]}"
  exit 1
fi
echo "all suites passed"
