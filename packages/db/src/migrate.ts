import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
export const MIGRATIONS_SCHEMA = 'drizzle';
export const MIGRATIONS_TABLE = '__drizzle_migrations';

/** Session advisory lock shared by every process that migrates the same database. */
const LOCK_NAME = 'pod-studio:migrations';

export type ConnectionOptions = string | postgres.Options<Record<string, postgres.PostgresType>>;

export interface MigrateOptions {
  /** Defaults to packages/db/migrations. Tests point this at a copy to exercise the guards. */
  migrationsFolder?: string;
}

export interface MigrateResult {
  /** Migrations applied by this call. 0 when the database was already up to date. */
  applied: number;
  /** Migrations recorded in the database after this call. */
  total: number;
}

interface AppliedRow {
  hash: string;
  created_at: string;
}

/**
 * Applies pending migrations in journal order.
 *
 * On top of Drizzle's migrator this:
 * - holds a Postgres advisory lock, so two app or job processes starting together cannot both run
 *   the same DDL;
 * - refuses to run when an applied migration file was edited (hash mismatch) or when a pending
 *   migration is older than the newest applied one. Drizzle alone would silently skip the latter,
 *   which happens when two branches generate migrations and merge in the other order.
 */
export async function migrateDatabase(connection: ConnectionOptions, options: MigrateOptions = {}): Promise<MigrateResult> {
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  const settings = { max: 1, onnotice: () => {} };
  // max: 1 keeps the lock, the checks and Drizzle's transaction on one connection.
  const client = typeof connection === 'string' ? postgres(connection, settings) : postgres({ ...connection, ...settings });
  try {
    await client`select pg_advisory_lock(hashtext(${LOCK_NAME}))`;
    try {
      const files = readMigrationFiles({ migrationsFolder });
      const before = await appliedMigrations(client);
      assertHistoryMatches(files, before);
      await migrate(drizzle({ client }), {
        migrationsFolder,
        migrationsSchema: MIGRATIONS_SCHEMA,
        migrationsTable: MIGRATIONS_TABLE,
      });
      const after = await appliedMigrations(client);
      return { applied: after.length - before.length, total: after.length };
    } finally {
      await client`select pg_advisory_unlock(hashtext(${LOCK_NAME}))`;
    }
  } finally {
    await client.end();
  }
}

async function appliedMigrations(client: postgres.Sql): Promise<AppliedRow[]> {
  const table = `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`;
  const [exists] = await client<{ ok: boolean }[]>`select to_regclass(${table}) is not null as ok`;
  if (!exists?.ok) return [];
  return client<AppliedRow[]>`
    select hash, created_at::text as created_at
    from ${client(MIGRATIONS_SCHEMA)}.${client(MIGRATIONS_TABLE)}
    order by created_at, id`;
}

type MigrationFile = ReturnType<typeof readMigrationFiles>[number];

function assertHistoryMatches(files: MigrationFile[], applied: AppliedRow[]): void {
  const byMillis = new Map(files.map((f) => [String(f.folderMillis), f]));
  for (const row of applied) {
    const file = byMillis.get(row.created_at);
    if (!file) {
      throw new Error(`Database has migration ${row.created_at} that is not in the migrations folder. Deploy the matching code first.`);
    }
    if (file.hash !== row.hash) {
      throw new Error(`Applied migration ${row.created_at} was edited after it ran. Revert the edit and add a new migration instead.`);
    }
  }
  const last = applied.at(-1);
  if (!last) return;
  const lastMillis = Number(last.created_at);
  const appliedMillis = new Set(applied.map((r) => r.created_at));
  const skipped = files.filter((f) => !appliedMillis.has(String(f.folderMillis)) && f.folderMillis <= lastMillis);
  if (skipped.length) {
    throw new Error(
      `Pending migration(s) ${skipped.map((f) => f.folderMillis).join(', ')} are older than the last applied one ` +
        `(${lastMillis}) and would be skipped. Regenerate them after the latest migration.`,
    );
  }
}
