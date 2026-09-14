#!/usr/bin/env bash
# Tags the version in Cargo.toml and pushes the tag; the release workflow in
# .github/workflows/release.yml builds the binaries and publishes the release.

set -e
[ "$TRACE" ] && set -x

cd "$(dirname "$0")"
version=$(sed -n 's/^version *= *"\(.*\)"/\1/p' Cargo.toml | head -n 1)
tag="v$version"

git tag -f "$tag" -m "Release $tag"
git push origin "$tag"
