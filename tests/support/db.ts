import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { assertSafeDatabase, type DatabaseTarget } from './guard';

/**
 * Per-worker Postgres databases for integration tests.
 *
 * Each call to {@link createTestDatabase} creates a brand new database named
 * `pod_w<worker>_<random>_test` on the local Postgres 16 from ops/local/docker-compose.yml, so parallel
 * Vitest workers never share rows. `drop()` only removes a database that this process created; the
 * name is remembered in memory, never derived from user input or environment variables.
 */

export interface ServerSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Maintenance database used to issue CREATE/DROP DATABASE. */
  adminDatabase: string;
}

export function serverSettings(env: NodeJS.ProcessEnv = process.env): ServerSettings {
  return {
    host: env.TEST_PGHOST ?? '127.0.0.1',
    port: Number(env.TEST_PGPORT ?? 54316),
    user: env.TEST_PGUSER ?? 'pod',
    password: env.TEST_PGPASSWORD ?? 'pod-local-only',
    adminDatabase: env.TEST_PGADMIN_DB ?? 'postgres',
  };
}

export interface TestDatabase extends DatabaseTarget {
  sql: postgres.Sql;
  /** Closes the connection and drops the database. Safe to call more than once. */
  drop(): Promise<void>;
}

const created = new Set<string>();

function workerTag(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.VITEST_POOL_ID ?? env.VITEST_WORKER_ID ?? '0';
  return raw.replace(/[^a-z0-9]/gi, '').toLowerCase() || '0';
}

function admin(settings: ServerSettings): postgres.Sql {
  assertSafeDatabase({ host: settings.host, port: settings.port, database: 'guard_probe_test' });
  return postgres({
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    database: settings.adminDatabase,
    max: 1,
    onnotice: () => {},
  });
}

export async function createTestDatabase(settings: ServerSettings = serverSettings()): Promise<TestDatabase> {
  const database = `pod_w${workerTag()}_${randomBytes(4).toString('hex')}_test`;
  const target: DatabaseTarget = { host: settings.host, port: settings.port, database };
  assertSafeDatabase(target);

  const root = admin(settings);
  try {
    await root.unsafe(`CREATE DATABASE "${database}"`);
  } finally {
    await root.end({ timeout: 5 });
  }
  created.add(database);

  const sql = postgres({
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    database,
    max: 4,
    onnotice: () => {},
  });

  let dropped = false;
  return {
    ...target,
    sql,
    async drop() {
      if (dropped) return;
      dropped = true;
      await sql.end({ timeout: 5 });
      await dropOwnedDatabase(database, settings);
    },
  };
}

/** Drops a database only if this process created it. Returns false when it refused. */
export async function dropOwnedDatabase(database: string, settings: ServerSettings = serverSettings()): Promise<boolean> {
  if (!created.has(database)) return false;
  assertSafeDatabase({ host: settings.host, port: settings.port, database });
  const root = admin(settings);
  try {
    await root.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  } finally {
    await root.end({ timeout: 5 });
  }
  created.delete(database);
  return true;
}

export async function databaseExists(database: string, settings: ServerSettings = serverSettings()): Promise<boolean> {
  const root = admin(settings);
  try {
    const rows = await root`SELECT 1 FROM pg_database WHERE datname = ${database}`;
    return rows.length > 0;
  } finally {
    await root.end({ timeout: 5 });
  }
}
