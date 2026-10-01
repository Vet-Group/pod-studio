// Server-only: imported by the auth route handler and proxy.ts, never by client components.
import { createAuth, type Auth } from '@pod-studio/core';
import { createDatabase, type ConnectionOptions } from '@pod-studio/db';

/**
 * Same lookup as `pnpm db:migrate`: DATABASE_URL, or the standard PG* variables that postgres.js
 * reads itself (apps/web/.env.local in local dev).
 */
function connection(env: NodeJS.ProcessEnv): ConnectionOptions {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.PGDATABASE) return {};
  throw new Error('Set DATABASE_URL or PGDATABASE (copy apps/web/.env.example to apps/web/.env.local).');
}

function required(env: NodeJS.ProcessEnv, name: 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL'): string {
  const value = env[name];
  if (!value) throw new Error(`Set ${name} (copy apps/web/.env.example to apps/web/.env.local).`);
  return value;
}

function build(env: NodeJS.ProcessEnv): Auth {
  const { db } = createDatabase(connection(env));
  return createAuth({
    db,
    secret: required(env, 'BETTER_AUTH_SECRET'),
    baseURL: required(env, 'BETTER_AUTH_URL'),
    trustedOrigins: env.BETTER_AUTH_TRUSTED_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean),
  });
}

// One pool per server process; dev hot reload would otherwise open a new pool on every edit.
const globalForAuth = globalThis as typeof globalThis & { podStudioAuth?: Auth };

/** The server-side better-auth instance. Created on first use so builds never need database env vars. */
export function getAuth(): Auth {
  globalForAuth.podStudioAuth ??= build(process.env);
  return globalForAuth.podStudioAuth;
}
