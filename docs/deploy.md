# Deploying POD Studio

One Linux host running Docker Compose: Caddy (TLS) in front of the Next.js app, with Postgres and
MinIO on an internal network. Everything an operator runs lives in `ops/prod/`; the app image is
built from `ops/docker/Dockerfile`.

```
internet ──443──▶ caddy ──▶ web:3000              (app, auth, API)
                       └──▶ minio:9000            (/<bucket>/... presigned object URLs only)
                  migrate (one-shot)  ──▶ postgres
                  minio-init (one-shot) ──▶ minio (bucket + least-privilege app user)
```

## Requirements

- Linux host with Docker Engine 24+ and the Compose plugin; 2 vCPU, 4 GB RAM, disk for designs.
- A DNS name (`APP_DOMAIN`) whose A/AAAA record points at the host, and ports 80/443 open.
  Caddy obtains and renews the certificate itself.
- Off-host storage for backups.

## First install

```sh
git clone <repo> pod-studio && cd pod-studio
docker build -f ops/docker/Dockerfile -t pod-studio-web:$(git rev-parse --short HEAD) .
cp ops/prod/.env.example ops/prod/.env && chmod 600 ops/prod/.env
# Edit ops/prod/.env: APP_DOMAIN, ACME_EMAIL, APP_IMAGE (the tag above), and every secret.
docker compose -f ops/prod/docker-compose.yml --env-file ops/prod/.env up -d --wait
ops/prod/smoke.sh https://$APP_DOMAIN
```

`up --wait` returns once Postgres and MinIO are healthy, migrations have applied, the bucket and
app user exist, the app answers `/api/health/ready`, and Caddy is serving.

Create the first admin (only works while no admin exists). It prints a one-time temporary
password; the admin must choose a new one at the first sign-in:

```sh
docker compose -f ops/prod/docker-compose.yml --env-file ops/prod/.env \
  run --rm migrate node tools/create-admin.mjs --email you@example.com --name "Your Name"
```

Every later account is created by that admin from **Stores & members** (invite link or temporary
password). There is no public sign-up.

## Secrets

All secrets live in `ops/prod/.env` (mode 600, never committed). Generate them with
`openssl rand -base64 32` (or `openssl rand -hex 24` for passwords).

| Variable | Purpose | Rotation |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Signs session cookies | Rotating signs everyone out |
| `POSTGRES_PASSWORD` | Database owner | Change in Postgres (`alter role`) first, then `.env` |
| `MINIO_ROOT_PASSWORD` | MinIO admin, used only by `minio-init` and backups | Set only on first start; later changes need `mc admin` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | App's bucket-scoped account | Edit `.env`, `up -d`; `minio-init` resets the secret |
| `SHOPIFY_ENCRYPTION_KEYS` / `_ACTIVE_KEY` | Encrypts Shopify credentials at rest | Add a new version, make it active, keep old ones listed until re-encrypted |

## Upgrading

```sh
git pull
docker build -f ops/docker/Dockerfile -t pod-studio-web:$(git rev-parse --short HEAD) .
ops/prod/backup.sh                          # always back up before migrating
# Set APP_IMAGE in ops/prod/.env to the new tag, then:
docker compose -f ops/prod/docker-compose.yml --env-file ops/prod/.env up -d --wait
ops/prod/smoke.sh https://$APP_DOMAIN
```

The `migrate` service runs before `web` starts. The migrator takes an advisory lock, applies only
pending files in order, and refuses to run when an applied migration file was edited, so a bad
release stops before the new app starts. Migrations are forward-only: to roll back a release that
already migrated, restore the pre-upgrade backup and set `APP_IMAGE` back to the previous tag.

## Backups and restore

```sh
ops/prod/backup.sh [backup-root]            # default: ops/prod/backups/<UTC timestamp>/
ops/prod/restore.sh ops/prod/backups/<timestamp> --yes
```

A backup holds `database.dump` (Postgres custom format), `objects/` (a mirror of the bucket), and
`SHA256SUMS`. Schedule it daily (cron or a systemd timer) and copy each folder off the host.

`restore.sh` verifies the checksums, loads the dump into a scratch database, and only then stops
the app and swaps databases. A dump that fails to load leaves the live database and app running.
The replaced database is kept as `<POSTGRES_DB>_before_<timestamp>` until you drop it; the command
is printed at the end. Objects are mirrored back with overwrite and are never deleted.

Run a restore drill after every schema-changing release: back up, restore into the same stack, run
`smoke.sh`. CI runs the same drill on every pull request (`image` job in `.github/workflows/ci.yml`).

## Health and logs

- `GET /api/health`: liveness, no dependencies (image `HEALTHCHECK`).
- `GET /api/health/ready`: 200 when Postgres answers, 503 otherwise (compose healthcheck).
- `docker compose ... logs -f web caddy`: app logs and JSON access logs.
- The `audit_log` table is append-only (database triggers reject `UPDATE`, `DELETE`, `TRUNCATE`).

## Using an external S3 service instead of MinIO

Point `S3_ENDPOINT` (server-side calls) and `S3_PUBLIC_ENDPOINT` (presigned URLs that browsers use)
at the provider, set the bucket and keys, remove the `minio` and `minio-init` services, and remove
the `@objects` route from `ops/prod/Caddyfile`. Configure the bucket's CORS to allow `PUT` and `GET`
from `https://$APP_DOMAIN`.

## Local rehearsal

The stack runs on a workstation without a public DNS name: set `APP_DOMAIN=localhost:18443`,
`HTTP_PORT=18080`, `HTTPS_PORT=18443`, and pass `SMOKE_INSECURE=1` to `smoke.sh` (Caddy uses its
internal CA for `localhost`).
