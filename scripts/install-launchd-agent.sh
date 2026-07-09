#!/bin/sh
# Installs the local launchd job that polls origin/main and refreshes the
# graphify graph (see scripts/sync-main-graphify.sh). Opt-in, run manually —
# unlike the git hooks (scripts/install-git-hooks.sh), this starts a standing
# background job on your machine, so it isn't wired into `pnpm install`.
#
# The committed plist has a __REPO_ROOT__ placeholder instead of a hardcoded
# path because the repo location differs per machine/clone; this substitutes
# it with this checkout's actual path before loading.
set -e

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
label="social.cloudhub.charm.sync-main-graphify"
src="$repo_root/scripts/$label.plist"
dest="$HOME/Library/LaunchAgents/$label.plist"

mkdir -p "$HOME/Library/LaunchAgents"
sed "s#__REPO_ROOT__#$repo_root#g" "$src" > "$dest"

launchctl unload "$dest" 2>/dev/null || true
launchctl load "$dest"

echo "Installed and loaded $label (polls every 15 min)."
echo "Logs: /tmp/charm-sync-main-graphify.log"
echo "To remove: launchctl unload '$dest' && rm '$dest'"
