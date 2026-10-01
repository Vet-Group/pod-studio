import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../../../tests/support/db';
import { createDatabase } from '../src/client';
import { MIGRATIONS_FOLDER, migrateDatabase } from '../src/migrate';
import { auditLog, storeMembers, stores, users } from '../src/schema';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function emptyDatabase(): Promise<TestDatabase> {
  const d = await createTestDatabase();
  cleanup.push(() => d.drop());
  return d;
}

async function migratedDatabase(): Promise<TestDatabase> {
  const d = await emptyDatabase();
  await migrateDatabase(d.connection);
  return d;
}

const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};

/** Structural fingerprint of the public schema, used to prove a second run changes nothing. */
async function schemaFingerprint(sql: TestDatabase['sql']): Promise<string> {
  const rows = await sql`
    select 'column' as kind, table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') as item
      from information_schema.columns where table_schema = 'public'
    union all
    select 'constraint', conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid)
      from pg_constraint where connamespace = 'public'::regnamespace
    union all
    select 'index', indexdef from pg_indexes where schemaname = 'public'
    union all
    select 'trigger', tgrelid::regclass::text || '.' || tgname from pg_trigger where not tgisinternal
    order by 1, 2`;
  return rows.map((r) => `${r.kind} ${r.item}`).join('\n');
}

describe('migrations', () => {
  it('journal is ordered and every entry has a SQL file', () => {
    expect(journal.entries.length).toBeGreaterThan(0);
    journal.entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
      expect(entry.tag.startsWith(String(i).padStart(4, '0') + '_')).toBe(true);
      if (i > 0) expect(entry.when).toBeGreaterThan(journal.entries[i - 1]!.when);
      expect(() => readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), 'utf8')).not.toThrow();
    });
  });

  it('apply cleanly to an empty database, and a second run changes nothing', async () => {
    const d = await emptyDatabase();
    const first = await migrateDatabase(d.connection);
    expect(first).toEqual({ applied: journal.entries.length, total: journal.entries.length });
    const before = await schemaFingerprint(d.sql);
    expect(before).toContain('audit_log');

    const second = await migrateDatabase(d.connection);
    expect(second).toEqual({ applied: 0, total: journal.entries.length });
    expect(await schemaFingerprint(d.sql)).toBe(before);
  });

  it('two processes migrating at once apply each migration exactly once', async () => {
    const d = await emptyDatabase();
    const results = await Promise.all([migrateDatabase(d.connection), migrateDatabase(d.connection), migrateDatabase(d.connection)]);
    expect(results.map((r) => r.applied).sort()).toEqual([0, 0, journal.entries.length]);
    const [row] = await d.sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(row?.n).toBe(journal.entries.length);
  });

  it('create the expected tables', async () => {
    const d = await migratedDatabase();
    const rows = await d.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by 1`;
    expect(rows.map((r) => r.table_name)).toEqual(['accounts', 'asset_uploads', 'assets', 'audit_log', 'design_shares', 'designs', 'generation_jobs', 'generation_requester_turns', 'generation_store_turns', 'invites', 'pricing_rules', 'product_types', 'provider_accounts', 'sessions', 'shopify_connections', 'store_members', 'stores', 'users', 'verifications', 'workers']);
  });
});

describe('library permission upgrade', () => {
  it('grants existing owners library permissions with an audit row and preserves other grants', async () => {
    const d = await emptyDatabase();
    const folder = mkdtempSync(join(tmpdir(), 'pod-legacy-migrations-'));
    cleanup.push(() => rmSync(folder, { recursive: true, force: true }));
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const legacyJournal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8'));
    legacyJournal.entries = legacyJournal.entries.filter((entry: { idx: number }) => entry.idx < 4);
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(legacyJournal));
    await migrateDatabase(d.connection, { migrationsFolder: folder });
    const handle = createDatabase(d.connection);
    cleanup.push(() => handle.close());
    const db = handle.db;
    await db.insert(users).values([
      { id: 'legacy_owner_001', email: 'legacy-owner@example.test', name: 'Owner' },
      { id: 'legacy_viewer_001', email: 'legacy-viewer@example.test', name: 'Viewer' },
    ]);
    await db.insert(stores).values({ id: 'legacy_store_001', name: 'Legacy store', domain: 'legacy.myshopify.com' });
    await db.insert(storeMembers).values([
      { id: 'legacy_member_001', storeId: 'legacy_store_001', userId: 'legacy_owner_001', role: 'owner', permissions: ['store.view', 'store.members'] },
      { id: 'legacy_member_002', storeId: 'legacy_store_001', userId: 'legacy_viewer_001', role: 'viewer', permissions: ['store.view'] },
    ]);
    await migrateDatabase(d.connection);
    const members = await db.select().from(storeMembers).orderBy(storeMembers.id);
    expect(members[0]?.permissions).toEqual(['store.view', 'store.members', 'design.upload', 'design.share']);
    expect(members[1]?.permissions).toEqual(['store.view']);
    const logs = await db.select().from(auditLog);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorKind: 'system', action: 'store.member.library.upgrade', storeId: 'legacy_store_001', targetId: 'legacy_member_001' });
    await migrateDatabase(d.connection);
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });
});

describe('schema conventions (PRD §4)', () => {
  it('has no Postgres enum types', async () => {
    const d = await migratedDatabase();
    const rows = await d.sql`
      select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where t.typtype = 'e' and n.nspname not in ('pg_catalog', 'information_schema')`;
    expect(rows).toEqual([]);
  });

  it('has no CHECK constraints', async () => {
    const d = await migratedDatabase();
    const rows = await d.sql`select conname from pg_constraint where contype = 'c' and connamespace = 'public'::regnamespace`;
    expect(rows).toEqual([]);
  });

  it('uses a text primary key named id on every table', async () => {
    const d = await migratedDatabase();
    const rows = await d.sql<{ table_name: string; columns: string; types: string }[]>`
      select c.conrelid::regclass::text as table_name,
             string_agg(a.attname, ',') as columns,
             string_agg(format_type(a.atttypid, a.atttypmod), ',') as types
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'p' and c.connamespace = 'public'::regnamespace
      group by 1 order by 1`;
    expect(rows).toHaveLength(20);
    for (const row of rows) expect({ table: row.table_name, columns: row.columns, types: row.types }).toEqual({ table: row.table_name, columns: 'id', types: 'text' });
  });

  it('stores every timestamp as timestamptz', async () => {
    const d = await migratedDatabase();
    const rows = await d.sql<{ col: string; data_type: string }[]>`
      select table_name || '.' || column_name as col, data_type from information_schema.columns
      where table_schema = 'public' and (data_type like 'timestamp%' or data_type in ('date', 'time without time zone', 'time with time zone'))`;
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((r) => r.data_type !== 'timestamp with time zone')).toEqual([]);
  });

  it('defaults created_at and updated_at to now()', async () => {
    const d = await migratedDatabase();
    const rows = await d.sql<{ col: string; column_default: string | null; is_nullable: string }[]>`
      select table_name || '.' || column_name as col, column_default, is_nullable from information_schema.columns
      where table_schema = 'public' and column_name in ('created_at', 'updated_at')`;
    // invites is append-mostly (accepted_at / revoked_at record changes), so it only has created_at.
    expect(rows.length).toBe(35);
    for (const row of rows) expect({ col: row.col, d: row.column_default, n: row.is_nullable }).toEqual({ col: row.col, d: 'now()', n: 'NO' });
  });
});

describe('tables', () => {
  it('insert rows with generated ids and timestamps, and refresh updated_at on update', async () => {
    const d = await migratedDatabase();
    const h = createDatabase(d.connection, { max: 2 });
    cleanup.push(() => h.close());

    const [user] = await h.db.insert(users).values({ name: 'Lan', email: 'lan@example.test' }).returning();
    expect(user?.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(user?.role).toBe('member');
    expect(user?.createdAt).toBeInstanceOf(Date);

    const [store] = await h.db.insert(stores).values({ name: 'Cloud Grove', domain: 'cloudgrove.myshopify.com' }).returning();
    expect(store?.apiVersion).toBe('2026-07');

    await new Promise((r) => setTimeout(r, 20));
    const [renamed] = await h.db.update(stores).set({ name: 'Cloud Grove Studio' }).where(eq(stores.id, store!.id)).returning();
    expect(renamed!.updatedAt.getTime()).toBeGreaterThan(store!.updatedAt.getTime());
    expect(renamed!.createdAt.getTime()).toBe(store!.createdAt.getTime());
  });

  it('treats store domains as case-insensitive unique', async () => {
    const d = await migratedDatabase();
    await d.sql`insert into stores (id, name, domain) values ('store_a_001', 'A', 'shop.myshopify.com')`;
    await expect(d.sql`insert into stores (id, name, domain) values ('store_b_001', 'B', 'Shop.MyShopify.com')`).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('treats user emails as unique', async () => {
    const d = await migratedDatabase();
    await d.sql`insert into users (id, name, email) values ('user_a_001', 'A', 'a@example.test')`;
    await expect(d.sql`insert into users (id, name, email) values ('user_b_001', 'B', 'a@example.test')`).rejects.toMatchObject({ code: '23505' });
  });

  it('removes sessions and accounts when a user is deleted', async () => {
    const d = await migratedDatabase();
    await d.sql`insert into users (id, name, email) values ('user_a_001', 'A', 'a@example.test')`;
    await d.sql`insert into sessions (id, token, user_id, expires_at) values ('sess_a_001', 'tok-a', 'user_a_001', now() + interval '1 day')`;
    await d.sql`insert into accounts (id, account_id, provider_id, user_id, password) values ('acct_a_001', 'user_a_001', 'credential', 'user_a_001', 'hash')`;
    await d.sql`delete from users where id = 'user_a_001'`;
    const [row] = await d.sql<{ s: number; a: number }[]>`select (select count(*)::int from sessions) as s, (select count(*)::int from accounts) as a`;
    expect(row).toEqual({ s: 0, a: 0 });
  });

  it('defaults must_change_password to false for new users', async () => {
    const d = await migratedDatabase();
    await d.sql`insert into users (id, name, email) values ('user_a_001', 'A', 'a@example.test')`;
    const [row] = await d.sql<{ must: boolean }[]>`select must_change_password as must from users`;
    expect(row).toEqual({ must: false });
  });

  it('keeps invite token hashes unique and invites tied to their inviter', async () => {
    const d = await migratedDatabase();
    await d.sql`insert into users (id, name, email) values ('user_a_001', 'A', 'a@example.test')`;
    await d.sql`insert into invites (id, email, token_hash, invited_by, expires_at)
      values ('invite_a_01', 'b@example.test', 'hash-1', 'user_a_001', now() + interval '7 days')`;
    const [row] = await d.sql<{ role: string; permissions: string[] }[]>`select global_role as role, permissions from invites`;
    expect(row).toEqual({ role: 'member', permissions: [] });
    await expect(
      d.sql`insert into invites (id, email, token_hash, invited_by, expires_at)
        values ('invite_b_01', 'c@example.test', 'hash-1', 'user_a_001', now() + interval '7 days')`,
    ).rejects.toMatchObject({ code: '23505' });
    await expect(d.sql`delete from users where id = 'user_a_001'`).rejects.toMatchObject({ code: '23503' });
  });
});

describe('audit_log', () => {
  async function withEntry() {
    const d = await migratedDatabase();
    const h = createDatabase(d.connection, { max: 2 });
    cleanup.push(() => h.close());
    const [user] = await h.db.insert(users).values({ name: 'Lan', email: 'lan@example.test' }).returning();
    const [store] = await h.db.insert(stores).values({ name: 'Cloud Grove', domain: 'cloudgrove.myshopify.com' }).returning();
    const [entry] = await h.db
      .insert(auditLog)
      .values({
        actorKind: 'user',
        actorUserId: user!.id,
        storeId: store!.id,
        action: 'store.member.grant',
        targetType: 'user',
        targetId: user!.id,
        data: { permission: 'product.publish' },
        requestId: 'req-1',
        ip: '2001:db8::1',
      })
      .returning();
    return { d, h, user: user!, store: store!, entry: entry! };
  }

  it('stores actor, store, request metadata and an IPv6 address', async () => {
    const { entry, user, store } = await withEntry();
    expect(entry).toMatchObject({ actorKind: 'user', actorUserId: user.id, storeId: store.id, requestId: 'req-1', ip: '2001:db8::1' });
    expect(entry.data).toEqual({ permission: 'product.publish' });
  });

  it('accepts system entries without a user or request', async () => {
    const { h } = await withEntry();
    const [row] = await h.db.insert(auditLog).values({ actorKind: 'system', action: 'session.reap' }).returning();
    expect(row).toMatchObject({ actorUserId: null, storeId: null, requestId: null, ip: null, data: {} });
  });

  it('rejects UPDATE, DELETE and TRUNCATE', async () => {
    const { d, entry } = await withEntry();
    await expect(d.sql`update audit_log set action = 'x' where id = ${entry.id}`).rejects.toThrow(/append-only: UPDATE/);
    await expect(d.sql`delete from audit_log where id = ${entry.id}`).rejects.toThrow(/append-only: DELETE/);
    await expect(d.sql`truncate audit_log`).rejects.toThrow(/append-only: TRUNCATE/);
    const [row] = await d.sql<{ action: string }[]>`select action from audit_log where id = ${entry.id}`;
    expect(row?.action).toBe('store.member.grant');
  });

  it('blocks deleting a user or store that appears in the log', async () => {
    const { d, user, store } = await withEntry();
    await expect(d.sql`delete from users where id = ${user.id}`).rejects.toMatchObject({ code: '23503' });
    await expect(d.sql`delete from stores where id = ${store.id}`).rejects.toMatchObject({ code: '23503' });
  });
});

describe('migration safety guards', () => {
  function copyMigrations(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pod-migrations-'));
    cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it('refuses to run when an applied migration was edited', async () => {
    const d = await migratedDatabase();
    const dir = copyMigrations();
    const first = journal.entries[0]!;
    const file = join(dir, `${first.tag}.sql`);
    writeFileSync(file, readFileSync(file, 'utf8') + '\n-- edited after it ran\n');
    await expect(migrateDatabase(d.connection, { migrationsFolder: dir })).rejects.toThrow(/was edited after it ran/);
  });

  it('refuses a pending migration older than the last applied one instead of skipping it', async () => {
    const d = await migratedDatabase();
    const dir = copyMigrations();
    const meta = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as typeof journal;
    const older = meta.entries[0]!.when + 1;
    meta.entries.push({ ...meta.entries[0]!, idx: meta.entries.length, when: older, tag: '9999_merged_late' } as (typeof meta.entries)[number]);
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(meta));
    writeFileSync(join(dir, '9999_merged_late.sql'), 'CREATE TABLE merged_late (id text PRIMARY KEY);');
    await expect(migrateDatabase(d.connection, { migrationsFolder: dir })).rejects.toThrow(/would be skipped/);
    const [row] = await d.sql<{ t: string | null }[]>`select to_regclass('public.merged_late')::text as t`;
    expect(row?.t).toBeNull();
  });

  it('refuses when the database is ahead of the code', async () => {
    const d = await migratedDatabase();
    await d.sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('future', ${String(Date.now() + 10 ** 9)})`;
    await expect(migrateDatabase(d.connection)).rejects.toThrow(/not in the migrations folder/);
  });
});
