#!/usr/bin/env bash
set -euo pipefail
# Stage a release without replacing dependencies underneath existing daemon processes.
host=${1:?Usage: scripts/deploy.sh SSH_HOST}
if [[ "$host" == -* || "$host" =~ [[:space:]] ]]; then
  printf 'Use an SSH host alias, not SSH arguments.\n' >&2
  exit 1
fi
cd "$(dirname "$0")/.."
npm run build
archive=$(mktemp -t pi-remote.XXXXXX)
trap 'rm -f "$archive"' EXIT
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$archive" package.json package-lock.json dist bin completions examples
remote_archive=$(ssh -o BatchMode=yes "$host" 'mktemp /tmp/pi-remote-deploy.XXXXXX')
if [[ ! "$remote_archive" =~ ^/tmp/pi-remote-deploy\.[a-zA-Z0-9]+$ ]]; then
  printf 'Unexpected remote temporary path.\n' >&2
  exit 1
fi
scp -q "$archive" "$host:$remote_archive"
ssh -o BatchMode=yes "$host" bash -s -- "$remote_archive" <<'REMOTE'
set -euo pipefail
archive=$1
base="$HOME/.local/share/pi-remote"
mkdir -p "$base/releases" "$base/bin"
release=$(mktemp -d "$base/releases/release.XXXXXX")
trap 'rm -f "$archive"' EXIT
tar -xzf "$archive" -C "$release"
cd "$release"
npm ci --omit=dev --ignore-scripts
chmod +x bin/pi-remote
bin/pi-remote --version
# Validate packaged assets before switching the stable launcher.
bin/pi-remote completion fish >/dev/null
ln -s "$release/bin/pi-remote" "$base/bin/.pi-remote-$(basename "$release")"
mv -Tf "$base/bin/.pi-remote-$(basename "$release")" "$base/bin/pi-remote"
# Retain prior releases and legacy files: live processes may still import them.
REMOTE
printf 'Installed on %s. Existing daemon processes were not restarted.\n' "$host"
