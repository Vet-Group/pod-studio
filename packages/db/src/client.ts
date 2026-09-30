import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { ConnectionOptions } from './migrate';
import * as schema from './schema';

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;

export interface DatabaseHandle {
  db: Database;
  /** Underlying postgres.js client; call `close()` instead of ending it directly. */
  client: postgres.Sql;
  close(): Promise<void>;
}

/** Opens a pooled connection with the full schema attached for relational queries. */
export function createDatabase(connection: ConnectionOptions, options: { max?: number } = {}): DatabaseHandle {
  const settings = { max: options.max ?? 10, onnotice: () => {} };
  const client = typeof connection === 'string' ? postgres(connection, settings) : postgres({ ...connection, ...settings });
  return { db: drizzle({ client, schema }), client, close: () => client.end() };
}
