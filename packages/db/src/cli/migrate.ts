import { migrateDatabase, type ConnectionOptions } from '../migrate';

/**
 * `pnpm db:migrate`: applies pending migrations to the database in DATABASE_URL, or in the standard
 * PG* variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE). The package script loads
 * apps/web/.env.local when it exists.
 */
function target(env: NodeJS.ProcessEnv): { connection: ConnectionOptions; label: string } {
  if (env.DATABASE_URL) {
    const url = new URL(env.DATABASE_URL);
    return { connection: env.DATABASE_URL, label: `${url.hostname}:${url.port || 5432}${url.pathname}` };
  }
  if (env.PGDATABASE) {
    // postgres.js reads the PG* variables itself when no options are given.
    return { connection: {}, label: `${env.PGHOST ?? 'localhost'}:${env.PGPORT ?? 5432}/${env.PGDATABASE}` };
  }
  throw new Error('Set DATABASE_URL or PGDATABASE (copy apps/web/.env.example to apps/web/.env.local for local dev).');
}

try {
  const { connection, label } = target(process.env);
  console.log(`[db] migrating ${label}`);
  const { applied, total } = await migrateDatabase(connection);
  console.log(applied ? `[db] applied ${applied} migration(s); ${total} in total` : `[db] up to date (${total} migrations)`);
} catch (error) {
  console.error(`[db] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
