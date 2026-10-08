#!/usr/bin/env bash
set -euo pipefail
# Install this checkout as a new remote release, point the stable launcher at it, then
# restart the daemon on it if every slot is idle. See README "Deployment".
usage='Usage: scripts/deploy.sh [SSH_HOST] [--wait | --no-restart]'
host='' restart=(restart-daemon)
for arg in "$@"; do
  case "$arg" in
    --wait) restart=(restart-daemon --wait) ;;
    --no-restart) restart=() ;;
    -h|--help) printf '%s\n' "$usage"; exit 0 ;;
    -*) printf 'Unknown option %s\n%s\n' "$arg" "$usage" >&2; exit 1 ;;
    *) [[ -z "$host" ]] || { printf '%s\n' "$usage" >&2; exit 1; }; host=$arg ;;
  esac
done
cd "$(dirname "$0")/.."
# Same default host as the CLI: PI_REMOTE_HOST, then the config file.
[[ -n "$host" ]] || host=$(node --import tsx -e 'import("./src/config.ts").then(m => console.log(m.defaultHost() ?? ""))')
if [[ -z "$host" || "$host" == -* || "$host" =~ [[:space:]] ]]; then
  printf 'Give an SSH host alias, or set a default host (see README "Configuration").\n' >&2
  exit 1
fi
dirty=$([[ -z "$(git status --porcelain)" ]] || echo -dirty)
release="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)$dirty"
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
ssh -o BatchMode=yes "$host" bash -s -- "$remote_archive" "$release" <<'REMOTE'
set -euo pipefail
archive=$1 name=$2
[[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]+(-dirty)?$ ]] || { printf 'Invalid release name %s\n' "$name" >&2; exit 1; }
base="$HOME/.local/share/pi-remote"
release="$base/releases/$name"
trap 'rm -f "$archive"' EXIT
mkdir -p "$base/releases" "$base/bin"
mkdir "$release"
tar -xzf "$archive" -C "$release"
cd "$release"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
chmod +x bin/pi-remote
# Validate the release before switching the stable launcher to it.
bin/pi-remote --version
bin/pi-remote completion fish >/dev/null
previous=$(readlink "$base/bin/pi-remote" || true)
ln -s "$release/bin/pi-remote" "$base/bin/.pi-remote-$name"
mv -Tf "$base/bin/.pi-remote-$name" "$base/bin/pi-remote"
# Releases never change after install, because a running daemon may still load modules
# from its own release. Keep the current one, the previous one, and any that a running
# process uses; delete the rest.
keep=" $release ${previous%/bin/pi-remote} $(ps -eo args= | grep -oE "$base/releases/[^/ ]+" | sort -u | tr "\n" " " || true) "
for dir in "$base"/releases/*; do
  [[ "$keep" == *" $dir "* ]] || rm -rf "$dir"
done
REMOTE
printf 'Installed release %s on %s.\n' "$release" "$host"
[[ ${#restart[@]} -gt 0 ]] || { printf 'Daemon not restarted (--no-restart). Run pi-remote restart-daemon when ready.\n'; exit 0; }
bin/pi-remote "${restart[@]}" --host "$host" || {
  printf 'The release is installed, but the daemon still runs its old release. Run pi-remote restart-daemon --wait when ready.\n' >&2
  exit 1
}
