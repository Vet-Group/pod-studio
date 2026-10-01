export * from './schema';
export { ID_PATTERN, isId, newId } from './ids';
// Query operators re-exported so every workspace package builds queries against this package's
// drizzle-orm instance (a second copy, e.g. one resolved with better-auth's kysely peer, breaks types).
export { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, not, or, sql } from 'drizzle-orm';
export { createDatabase, type Database, type DatabaseHandle, type Schema } from './client';
export {
  MIGRATIONS_FOLDER,
  migrateDatabase,
  type ConnectionOptions,
  type MigrateOptions,
  type MigrateResult,
} from './migrate';
