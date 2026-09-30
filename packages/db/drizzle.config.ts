import { defineConfig } from 'drizzle-kit';

// Only `generate` and `check` use this file. Apply migrations with `pnpm db:migrate`, which adds a
// lock and ordering checks on top of Drizzle's migrator (src/migrate.ts).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  migrations: { schema: 'drizzle', table: '__drizzle_migrations' },
  strict: true,
  verbose: true,
});
