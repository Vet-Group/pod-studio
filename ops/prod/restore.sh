#!/bin/sh
# Restore a backup made by ops/prod/backup.sh into the running production stack.
#
#   ops/prod/restore.sh <backup-folder> --yes
#
# The dump is first restored into a scratch database. Only when that succeeds is the web app
# stopped and the scratch database swapped in; the previous database is kept, renamed to
# <db>_before_<timestamp>, as a rollback (drop it once the restore is verified). A failed load
# leaves the live database and the running app untouched.
#
# Objects are mirrored back into the bucket with overwrite; objects missing from the backup are left
# in place, never deleted.
set -eu

COMPOSE_FILE=${COMPOSE_FILE:-ops/prod/docker-compose.yml}
ENV_FILE=${ENV_FILE:-ops/prod/.env}
COMPOSE_PROJECT=${COMPOSE_PROJECT:-pod-studio-prod}
src=${1:?usage: ops/prod/restore.sh <backup-folder> --yes}
src=${src%/}
[ "${2:-}" = "--yes" ] || { echo "refusing to restore without --yes (this replaces the database)" >&2; exit 2; }
[ -f "$src/database.dump" ] || { echo "no database.dump in $src" >&2; exit 1; }

dc() { docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
# Runs a shell snippet inside the postgres container, where POSTGRES_USER/POSTGRES_DB are set.
pg() { dc exec -T -e STAMP="$stamp" postgres sh -c "$1"; }

if [ -f "$src/SHA256SUMS" ]; then
  echo "[restore] verifying checksums"
  (cd "$src" && sha256sum -c --quiet SHA256SUMS)
fi
src_abs=$(cd "$src" && pwd)

echo "[restore] loading $src/database.dump into a scratch database"
pg 'dropdb -U "$POSTGRES_USER" --if-exists "${POSTGRES_DB}_restoring" && createdb -U "$POSTGRES_USER" "${POSTGRES_DB}_restoring"'
if ! pg 'pg_restore -U "$POSTGRES_USER" -d "${POSTGRES_DB}_restoring" --no-owner --exit-on-error' < "$src/database.dump"; then
  pg 'dropdb -U "$POSTGRES_USER" --if-exists "${POSTGRES_DB}_restoring"' || true
  echo "[restore] FAILED while loading the dump; the live database was not touched" >&2
  exit 1
fi

echo "[restore] stopping web and swapping databases"
dc stop web
pg 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -q \
  -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '"'"'$POSTGRES_DB'"'"' and pid <> pg_backend_pid()" \
  -c "alter database \"$POSTGRES_DB\" rename to \"${POSTGRES_DB}_before_$STAMP\"" \
  -c "alter database \"${POSTGRES_DB}_restoring\" rename to \"$POSTGRES_DB\""'

if [ -d "$src/objects" ]; then
  echo "[restore] objects <- $src/objects/"
  dc run --rm --no-deps -v "$src_abs/objects:/backup:ro" --entrypoint sh minio-init -c '
    export MC_CONFIG_DIR=/tmp/mc
    mc alias set pod http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
    mc mb --ignore-existing "pod/$S3_BUCKET" >/dev/null
    mc mirror --quiet --overwrite /backup "pod/$S3_BUCKET"
  '
fi

echo "[restore] applying any newer migrations, then starting web"
dc run --rm migrate
dc up -d --wait web
echo "[restore] done. The previous database is kept as <POSTGRES_DB>_before_$stamp; once verified:"
echo "  docker compose -p $COMPOSE_PROJECT -f $COMPOSE_FILE --env-file $ENV_FILE exec postgres sh -c 'dropdb -U \"\$POSTGRES_USER\" \"\${POSTGRES_DB}_before_$stamp\"'"
