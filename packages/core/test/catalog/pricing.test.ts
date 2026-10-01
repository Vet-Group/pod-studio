import { afterEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  createDatabase,
  eq,
  migrateDatabase,
  storeMembers,
  stores,
  users,
  type Database,
} from '@pod-studio/db';
import { createTestDatabase } from '../../../../tests/support/db';
import {
  ROLE_PRESETS,
  createProductType,
  updateProductType,
  savePriceTable,
  generateVariants,
  listCatalog,
  parsePrice,
  formatPrice,
  type Principal,
} from '../../src';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
const owner: Principal = { userId: 'catalog_owner', role: 'member' };
const viewer: Principal = { userId: 'catalog_viewer', role: 'member' };
const admin: Principal = { userId: 'catalog_admin', role: 'admin' };
const STORE = 'catalog_store';
const OTHER = 'catalog_other';
const input = {
  name: 'T-shirt',
  currency: 'USD',
  options: [
    { name: 'Size', values: ['S', 'M', 'L'] },
    { name: 'Color', values: ['White', 'Black'] },
  ],
};
const row = (size = 'M', color = 'White', price = '19.99') => ({
  optionValues: { Size: size, Color: color },
  price,
  excludedMarkets: ['DE'],
});
async function harness(): Promise<Database> {
  const test = await createTestDatabase();
  cleanup.push(() => test.drop());
  await migrateDatabase(test.connection);
  const handle = createDatabase(test.connection, { max: 4 });
  cleanup.push(() => handle.close());
  const db = handle.db;
  await db.insert(users).values([
    { id: owner.userId, name: 'Owner', email: 'owner@catalog.test' },
    { id: viewer.userId, name: 'Viewer', email: 'viewer@catalog.test' },
    {
      id: admin.userId,
      name: 'Admin',
      email: 'admin@catalog.test',
      role: 'admin',
    },
  ]);
  await db.insert(stores).values([
    { id: STORE, name: 'Catalog store', domain: 'catalog.myshopify.com' },
    { id: OTHER, name: 'Other store', domain: 'other-catalog.myshopify.com' },
  ]);
  await db.insert(storeMembers).values([
    {
      storeId: STORE,
      userId: owner.userId,
      role: 'owner',
      permissions: [...ROLE_PRESETS.owner],
    },
    {
      storeId: STORE,
      userId: viewer.userId,
      role: 'viewer',
      permissions: ['store.view'],
    },
    {
      storeId: OTHER,
      userId: owner.userId,
      role: 'viewer',
      permissions: ['store.view'],
    },
  ]);
  return db;
}

describe('catalog price table (PRD §20.1)', () => {
  it('generates exactly one variant per saved price row in sort_order, not all option combinations', async () => {
    const db = await harness();
    const type = await createProductType(db, owner, STORE, input);
    const saved = await savePriceTable(db, owner, STORE, type.id, {
      revision: type.revision,
      rows: [row('L', 'Black', '20.10'), row('S')],
    });
    const variants = await generateVariants(db, viewer, STORE, type.id);
    expect(variants).toHaveLength(2); // Three sizes × two colors would incorrectly generate six.
    expect(variants.map((v) => v.optionValues.Size)).toEqual(['L', 'S']);
    expect(variants.map((v) => v.sortOrder)).toEqual([0, 1]);
    expect(variants.map((v) => v.priceMinor)).toEqual([2010, 1999]);
    expect(variants[0]).toMatchObject({
      currency: 'USD',
      excludedMarkets: ['DE'],
      priceRowId: saved.rows[0]!.id,
    });
    const reordered = await savePriceTable(db, owner, STORE, type.id, {
      revision: saved.revision,
      rows: [
        { ...row('S'), id: saved.rows[1]!.id },
        { ...row('L', 'Black', '20.10'), id: saved.rows[0]!.id },
      ],
    });
    expect((await generateVariants(db, viewer, STORE, type.id)).map((v) => v.priceRowId)).toEqual(
      reordered.rows.map((r) => r.id),
    );
  });

  it('rejects a missing required option with a row-specific validation message and no write', async () => {
    const db = await harness();
    const type = await createProductType(db, owner, STORE, input);
    await expect(
      savePriceTable(db, owner, STORE, type.id, {
        revision: type.revision,
        rows: [{ ...row(), optionValues: { Size: 'S' } }],
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_CATALOG',
      issues: [
        expect.objectContaining({
          row: 0,
          field: 'Color',
          message: 'Row 1: Color is required.',
        }),
      ],
    });
    expect(await generateVariants(db, owner, STORE, type.id)).toEqual([]);
    expect(await db.select().from(auditLog).where(eq(auditLog.storeId, STORE))).toHaveLength(1);
  });

  it('does not let a member without store.settings or an ungranted admin edit', async () => {
    const db = await harness();
    const type = await createProductType(db, owner, STORE, input);
    for (const principal of [viewer, admin]) {
      await expect(createProductType(db, principal, STORE, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        updateProductType(db, principal, STORE, type.id, {
          ...input,
          revision: type.revision,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        savePriceTable(db, principal, STORE, type.id, {
          revision: type.revision,
          rows: [row()],
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect((await listCatalog(db, viewer, STORE)).canEdit).toBe(false);
  });

  it('scopes reads and writes to the store, including row identities', async () => {
    const db = await harness();
    const type = await createProductType(db, owner, STORE, input);
    await expect(generateVariants(db, owner, OTHER, type.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(listCatalog(db, viewer, OTHER)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const second = await createProductType(db, owner, STORE, {
      ...input,
      name: 'Hoodie',
    });
    const saved = await savePriceTable(db, owner, STORE, type.id, {
      revision: type.revision,
      rows: [row()],
    });
    await expect(
      savePriceTable(db, owner, STORE, second.id, {
        revision: second.revision,
        rows: [{ ...row(), id: saved.rows[0]!.id }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CATALOG' });
  });

  it('rejects invalid option values, duplicates, malformed money and markets', async () => {
    const db = await harness();
    const type = await createProductType(db, owner, STORE, input);
    for (const rows of [
      [row('XL')],
      [row(), row()],
      [row('M', 'White', '0.001')],
      [{ ...row(), excludedMarkets: ['Germany'] }],
    ]) {
      await expect(
        savePriceTable(db, owner, STORE, type.id, {
          revision: type.revision,
          rows,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CATALOG' });
    }
    await expect(
      createProductType(db, owner, STORE, {
        ...input,
        options: [{ name: 'Size', values: [] }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CATALOG' });
    await expect(createProductType(db, owner, STORE, { ...input, name: 't-SHIRT' })).rejects.toMatchObject({
      code: 'INVALID_CATALOG',
    });
  });

  it('audits creation, type edits and price edits atomically; removes rows and rejects stale saves', async () => {
    const db = await harness();
    const type = await createProductType(db, owner, STORE, input);
    const updated = await updateProductType(db, owner, STORE, type.id, {
      ...input,
      name: 'Premium T-shirt',
      revision: type.revision,
    });
    const saved = await savePriceTable(db, owner, STORE, type.id, {
      revision: updated.revision,
      rows: [row()],
    });
    await expect(
      savePriceTable(db, owner, STORE, type.id, {
        revision: updated.revision,
        rows: [],
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_CONFLICT' });
    await expect(
      updateProductType(db, owner, STORE, type.id, {
        ...input,
        revision: saved.revision,
        options: [{ name: 'Size', values: ['S'] }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CATALOG' });
    await savePriceTable(db, owner, STORE, type.id, {
      revision: saved.revision,
      rows: [],
    });
    expect(await generateVariants(db, owner, STORE, type.id)).toEqual([]);
    const logs = await db.select().from(auditLog).where(eq(auditLog.storeId, STORE));
    expect(logs.map((log) => log.action)).toEqual([
      'catalog.type.create',
      'catalog.type.update',
      'catalog.pricing.save',
      'catalog.pricing.save',
    ]);
    expect(logs.every((log) => log.actorUserId === owner.userId && log.targetId === type.id)).toBe(true);
  });
});

describe('exact two-decimal money', () => {
  it('parses and formats decimal strings without float arithmetic', () => {
    expect(parsePrice('0.29')).toBe(29);
    expect(parsePrice('20.10')).toBe(2010);
    expect(parsePrice('12.3')).toBe(1230);
    expect(formatPrice(29)).toBe('0.29');
    expect(formatPrice(2010)).toBe('20.10');
    for (const value of ['-1', '1e2', '0.001', 'NaN', '21474836.48', '']) expect(() => parsePrice(value)).toThrow();
  });
});
