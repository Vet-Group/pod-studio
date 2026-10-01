import { createInterface } from 'node:readline/promises';
import { createDatabase, type ConnectionOptions } from '@pod-studio/db';
import { createFirstAdmin } from '../auth/accounts';
import { isAuthError } from '../auth/errors';

/**
 * `pnpm auth:create-admin --email <email> --name <name>`: creates the first admin of a fresh install
 * and prints a one-time temporary password. Refuses once any admin exists; every later account comes
 * from that admin (invite link or temporary password). Reads the same env as `pnpm db:migrate`.
 */
function connection(env: NodeJS.ProcessEnv): ConnectionOptions {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.PGDATABASE) return {};
  throw new Error('Set DATABASE_URL or PGDATABASE (copy apps/web/.env.example to apps/web/.env.local for local dev).');
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

const args = process.argv.slice(2);
const handle = createDatabase(connection(process.env), { max: 1 });
try {
  const email = flag(args, 'email') ?? (await ask('Admin email: '));
  const name = flag(args, 'name') ?? (await ask('Admin name: '));
  const admin = await createFirstAdmin(handle.db, { email, name });
  console.log(`[auth] created admin ${admin.email}`);
  console.log(`[auth] temporary password (shown once): ${admin.temporaryPassword}`);
  console.log('[auth] sign in at /login; you will be asked to choose a new password.');
} catch (error) {
  console.error(`[auth] ${isAuthError(error) || error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await handle.close();
}
