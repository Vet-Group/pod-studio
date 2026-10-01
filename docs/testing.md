# Running development and tests

Documentation for P1-01. Requires only **Node 22.12+**, **pnpm** (via `corepack`) and **Docker Desktop**.

## From a clean checkout

```bash
corepack enable
pnpm install
pnpm services:up      # Postgres 16 (port 54316) + MinIO (port 19000, console 19001)
pnpm dev              # webapp: http://localhost:3100
```

`pnpm dev` serves the navigation shell for 7 screens (placeholders that name the task building each one) behind sign-in. Every page except `/login` and `/invite/<token>` needs a session; an account with a temporary password sees only `/change-password` until it picks its own.

Schemas and migrations are available from P1-02 (`packages/db`, see [database.md](database.md)). To set up the development database:

```bash
cp apps/web/.env.example apps/web/.env.local   # once; contains local values only
pnpm db:migrate                                # apply migrations to pod_dev
pnpm auth:create-admin --email you@example.com --name "Your Name"
```

`auth:create-admin` creates the first admin of an empty database and prints a one-time temporary password; sign in at `/login` and choose your own. It refuses once any admin exists: every later account comes from an admin, through an invite link or a temporary password (ADR 0002).

Quick check: `curl http://localhost:3100/api/health` returns `{"ok":true,...}`.

## Check commands

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | Generates Next route types, then runs `tsc` for the app, `packages/db` and the `tests/` directory |
| `pnpm lint` | ESLint for the entire repo (excludes `design/`, `packages/contracts/`, `tasks/`, which have their own checks) |
| `pnpm test` | Vitest: guards, isolation tests against real Postgres/MinIO, tests for `apps/web` and `packages/db` (migrations, schema conventions) |
| `pnpm db:migrate` | Applies pending migrations to the database in `DATABASE_URL` or `PG*` (reads `apps/web/.env.local` if present) |
| `pnpm db:generate` / `pnpm db:check` | Generates migrations from schemas / checks migration snapshots. See [database.md](database.md) for the workflow |
| `pnpm test:e2e` | Playwright at 1440px and 390px: navigation, 404, no horizontal overflow, axe WCAG 2.2 AA, 44px tap targets on mobile |
| `pnpm check` | `typecheck` + `lint` + `test` |

`pnpm test` automatically runs `docker compose up -d --wait` if Postgres or MinIO is not running. Set `TEST_SKIP_SERVICES_UP=1` to manage services yourself. `pnpm test:e2e` starts its own `next dev` on port 3100 (stop any other server on that port first) against a fresh `pod_e2e_<random>_test` database that it creates, migrates, seeds with an admin and drops afterwards (`tests/e2e/global-setup.ts`). It never reads `apps/web/.env.local` values for the database or auth secret, so E2E cannot touch `pod_dev`.

## Test data isolation

- Each test creates its own **database** `pod_w<worker>_<random>_test` and **bucket** `pod-w<worker>-<random>-test` (`tests/support/db.ts`, `tests/support/storage.ts`). Two parallel workers writing the same ID do not collide.
- Cleanup deletes only databases and buckets created by that process; other names (including `pod_dev`, `postgres`) are rejected.
- `tests/support/guard.ts` stops the entire test run before any test file is loaded if:
  - `DATABASE_URL` or `TEST_PGHOST` is not localhost,
  - the database name does not end in `_test`,
  - `S3_ENDPOINT` or `TEST_S3_ENDPOINT` is not local MinIO over `http`.

Configurable variables (defaults match `ops/local/docker-compose.yml`): `TEST_PGHOST`, `TEST_PGPORT`, `TEST_PGUSER`, `TEST_PGPASSWORD`, `TEST_S3_ENDPOINT`, `TEST_S3_ACCESS_KEY_ID`, `TEST_S3_SECRET_ACCESS_KEY`. Passwords in compose are for local machines only.

## Local services

| Service | Address | Notes |
| --- | --- | --- |
| Postgres 16 | `127.0.0.1:54316`, user `pod`, db `pod_dev` | Does not use 5432 because the development machine may already be running another Postgres instance |
| MinIO API | `http://127.0.0.1:19000` | `chainguard/minio` image pinned by digest; the official `minio/minio` image is no longer publicly pullable |
| MinIO console | `http://127.0.0.1:19001` | Log in with `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` from compose |

`pnpm services:down` stops services and preserves data; `pnpm services:reset` also deletes volumes.

## Notes

- The plan specifies `vitest.workspace.ts`; Vitest 5 removed the workspace file, so projects are declared in `vitest.config.ts` (`test.projects`).
- `packages/contracts` keeps its own npm lockfile and `npm run check` command; it is not part of the pnpm workspace until P1-07 connects the generated types to `apps/web`.
- The wireframe tests still run separately: `node design/wireframes/test-wireframes.mjs`.
