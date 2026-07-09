#!/bin/sh
# Installs the local launchd job that polls origin/main and refreshes the
# graphify graph (see scripts/sync-main-graphify.sh). Opt-in, run manually —
# unlike the git hooks (scripts/install-git-hooks.sh), this starts a standing
# background job on your machine, so it isn't wired into `pnpm install`.
#
# The committed plist has __REPO_ROOT__/__HOME_DIR__ placeholders instead of
# hardcoded paths because both differ per machine/clone; this substitutes
# them with this checkout's actual path and this user's home before loading.
# __HOME_DIR__ also seeds launchd's PATH (its default environment is a
# minimal one that often doesn't include Homebrew or pyenv/user-local bins,
# which is where graphify/pnpm commonly live) so the job can actually find
# them instead of silently retrying forever.
set -e

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
label="social.cloudhub.charm.sync-main-graphify"
src="$repo_root/scripts/$label.plist"
dest="$HOME/Library/LaunchAgents/$label.plist"

mkdir -p "$HOME/Library/LaunchAgents"
sed "s#__REPO_ROOT__#$repo_root#g; s#__HOME_DIR__#$HOME#g" "$src" > "$dest"

launchctl unload "$dest" 2>/dev/null || true
launchctl load "$dest"

echo "Installed and loaded $label (polls every 15 min)."
echo "Logs: /tmp/charm-sync-main-graphify.log"
echo "To remove: launchctl unload '$dest' && rm '$dest'"
