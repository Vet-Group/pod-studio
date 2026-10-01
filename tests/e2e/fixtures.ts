import { randomBytes } from 'node:crypto';
import { and, asc, auditLog, createDatabase, eq, migrateDatabase, storeMembers } from '../../packages/db/src';
import {
  addMember,
  changePassword,
  createFirstAdmin,
  createInvite,
  createStore,
  createUserWithTemporaryPassword,
  type Principal,
  type StorePermission,
  type StoreRole,
} from '../../packages/core/src';
import { assertSafeDatabase } from '../support/guard';
import { serverSettings } from '../support/db';

/**
 * Database the Playwright web server talks to. One fresh, migrated `pod_e2e_<random>_test` database
 * per run (global-setup creates it, global-teardown drops it), on the same guarded local Postgres as
 * the Vitest suite, so E2E never touches pod_dev.
 */
export const E2E_DATABASE_ENV = 'POD_E2E_DATABASE';

export function e2eConnection(database: string) {
  const pg = serverSettings();
  assertSafeDatabase({ host: pg.host, port: pg.port, database });
  return { host: pg.host, port: pg.port, user: pg.user, password: pg.password, database };
}

export function newE2eDatabaseName(): string {
  return `pod_e2e_${randomBytes(4).toString('hex')}_test`;
}

export async function withDatabase<T>(run: (db: ReturnType<typeof createDatabase>['db']) => Promise<T>): Promise<T> {
  const database = process.env[E2E_DATABASE_ENV];
  if (!database) throw new Error(`${E2E_DATABASE_ENV} is not set; run E2E through playwright.config.ts.`);
  const handle = createDatabase(e2eConnection(database), { max: 2 });
  try {
    return await run(handle.db);
  } finally {
    await handle.close();
  }
}

export async function migrate(database: string) {
  await migrateDatabase(e2eConnection(database));
}

/** Unique per call: tests run in parallel against one database. */
export function uniqueEmail(label: string): string {
  return `${label}-${randomBytes(4).toString('hex')}@example.test`;
}

export interface SeededAccount {
  userId: string;
  email: string;
  password: string;
}

/** The run's admin. Created once in global-setup through the same path as `pnpm auth:create-admin`. */
export async function seedAdmin(database: string): Promise<SeededAccount> {
  const handle = createDatabase(e2eConnection(database), { max: 1 });
  try {
    const admin = await createFirstAdmin(handle.db, { email: uniqueEmail('admin'), name: 'Avery Admin' });
    return { userId: admin.userId, email: admin.email, password: admin.temporaryPassword };
  } finally {
    await handle.close();
  }
}

export async function seedTemporaryAccount(admin: Principal, name: string): Promise<SeededAccount> {
  return withDatabase(async (db) => {
    const created = await createUserWithTemporaryPassword(db, admin, { email: uniqueEmail('staff'), name });
    return { userId: created.userId, email: created.email, password: created.temporaryPassword };
  });
}

export async function seedInvite(admin: Principal): Promise<{ token: string; email: string }> {
  return withDatabase(async (db) => {
    const invite = await createInvite({ db }, admin, { email: uniqueEmail('invitee') });
    return { token: invite.token, email: invite.email };
  });
}

/** An account that already chose its own password, so it signs straight into the app. */
export async function seedActiveAccount(admin: Principal, name: string): Promise<SeededAccount> {
  const temporary = await seedTemporaryAccount(admin, name);
  const password = `e2e-${randomBytes(6).toString('hex')}-password`;
  await withDatabase((db) =>
    changePassword(db, { userId: temporary.userId, currentPassword: temporary.password, newPassword: password }),
  );
  return { ...temporary, password };
}

/** Unique per call, like {@link uniqueEmail}: stores.domain is unique across the shared database. */
export function uniqueShopDomain(label: string): string {
  return `${label}-${randomBytes(4).toString('hex')}.myshopify.com`;
}

/** A store owned by `ownerUserId`, created through the same core path as the "+ New store" dialog. */
export async function seedStore(admin: Principal, name: string, ownerUserId: string): Promise<{ storeId: string }> {
  return withDatabase((db) => createStore(db, admin, { name, domain: uniqueShopDomain('shop'), ownerUserId }));
}

/**
 * Adds an existing account to a store with its role preset. `actor` must hold every permission of
 * that preset (ADR 0002), so seed co-leaders as the store owner rather than as an admin.
 */
export async function seedMember(actor: Principal, storeId: string, email: string, role: StoreRole): Promise<void> {
  await withDatabase((db) => addMember(db, actor, storeId, { email, role }));
}

export async function membershipOf(
  storeId: string,
  userId: string,
): Promise<{ role: string; permissions: StorePermission[] } | null> {
  return withDatabase(async (db) => {
    const [row] = await db
      .select({ role: storeMembers.role, permissions: storeMembers.permissions })
      .from(storeMembers)
      .where(and(eq(storeMembers.storeId, storeId), eq(storeMembers.userId, userId)));
    return row ? { role: row.role, permissions: row.permissions as StorePermission[] } : null;
  });
}

export interface AuditRow {
  action: string;
  actorUserId: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
}

/** The store's audit trail, oldest first. */
export async function storeAudit(storeId: string): Promise<AuditRow[]> {
  return withDatabase((db) =>
    db
      .select({ action: auditLog.action, actorUserId: auditLog.actorUserId, targetId: auditLog.targetId, data: auditLog.data })
      .from(auditLog)
      .where(eq(auditLog.storeId, storeId))
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id)),
  );
}
