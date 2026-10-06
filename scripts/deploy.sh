#!/usr/bin/env bash
set -euo pipefail
# Installs application code only; never changes Pi, credentials, extensions, or running slots.
host=${1:?Usage: scripts/deploy.sh SSH_HOST}
if [[ "$host" == -* || "$host" =~ [[:space:]] ]]; then
  printf 'Use an SSH host alias, not SSH arguments.\n' >&2
  exit 1
fi
cd "$(dirname "$0")/.."
npm run build
archive=$(mktemp -t pi-remote.XXXXXX)
trap 'rm -f "$archive"' EXIT
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$archive" package.json package-lock.json dist bin
remote_archive=$(ssh -o BatchMode=yes "$host" 'mktemp /tmp/pi-remote-deploy.XXXXXX')
if [[ ! "$remote_archive" =~ ^/tmp/pi-remote-deploy\.[a-zA-Z0-9]+$ ]]; then
  printf 'Unexpected remote temporary path.\n' >&2
  exit 1
fi
scp -q "$archive" "$host:$remote_archive"
ssh -o BatchMode=yes "$host" "mkdir -p \"\$HOME/.local/share/pi-remote\" && tar -xzf '$remote_archive' -C \"\$HOME/.local/share/pi-remote\" && rm '$remote_archive' && cd \"\$HOME/.local/share/pi-remote\" && npm ci --omit=dev --ignore-scripts && chmod +x bin/pi-remote && bin/pi-remote --version"
printf 'Installed on %s. Existing daemon processes were not restarted.\n' "$host"
