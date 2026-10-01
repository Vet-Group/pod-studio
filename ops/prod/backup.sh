#!/bin/sh
# Back up the POD Studio production stack: a Postgres custom-format dump plus a mirror of the
# object bucket. Run on the server from the repository root:
#
#   ops/prod/backup.sh [backup-root]        (default backup-root: ops/prod/backups)
#
# Produces <backup-root>/<UTC timestamp>/{database.dump,objects/,SHA256SUMS}. Copy that folder off
# the server (another disk, another provider); a backup that only lives next to the data is not one.
# Override COMPOSE_PROJECT / COMPOSE_FILE / ENV_FILE when the stack runs under other names.
set -eu

COMPOSE_FILE=${COMPOSE_FILE:-ops/prod/docker-compose.yml}
ENV_FILE=${ENV_FILE:-ops/prod/.env}
COMPOSE_PROJECT=${COMPOSE_PROJECT:-pod-studio-prod}
root=${1:-ops/prod/backups}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest="$root/$stamp"

dc() { docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

mkdir -p "$dest/objects"
dest_abs=$(cd "$dest" && pwd)

echo "[backup] database -> $dest/database.dump"
# Custom format: compressed, and pg_restore can restore it selectively or in parallel.
dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' \
  > "$dest/database.dump"

echo "[backup] objects -> $dest/objects/"
dc run --rm --no-deps --user 0 -v "$dest_abs/objects:/backup" --entrypoint sh minio-init -c '
  export MC_CONFIG_DIR=/tmp/mc
  mc alias set pod http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
  mc mirror --quiet --overwrite "pod/$S3_BUCKET" /backup
'

(cd "$dest" && find . -type f ! -name SHA256SUMS -exec sha256sum {} + | sort -k2 > SHA256SUMS)
size=$(du -sh "$dest" | cut -f1)
files=$(find "$dest/objects" -type f | wc -l | tr -d ' ')
echo "[backup] done: $dest ($size, $files object(s)); verify with: (cd $dest && sha256sum -c SHA256SUMS)"
