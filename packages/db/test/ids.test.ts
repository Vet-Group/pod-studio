import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ID_PATTERN, isId, newId } from '../src/ids';
import { accounts, auditLog, sessions, stores, users, verifications } from '../src/schema';

const contract = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'schemas', 'common.schema.json'), 'utf8'),
) as { $defs: { Id: { pattern: string } } };

describe('newId', () => {
  it('uses the exact Id pattern from packages/contracts', () => {
    expect(ID_PATTERN.source).toBe(contract.$defs.Id.pattern);
  });

  it('generates ids that match the contract pattern', () => {
    const pattern = new RegExp(contract.$defs.Id.pattern);
    for (let i = 0; i < 2000; i++) {
      const id = newId();
      expect(id).toMatch(pattern);
      expect(isId(id)).toBe(true);
    }
  });

  it('does not repeat across many calls', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId()));
    expect(ids.size).toBe(10_000);
  });

  it('rejects values outside the pattern', () => {
    for (const bad of ['', 'short7c', 'x'.repeat(41), 'has space1', 'dấu-tiếng-việt', 'a/b/c/d/e', 42, null]) {
      expect(isId(bad)).toBe(false);
    }
  });

  it('is the default primary key for every table', () => {
    for (const table of [users, sessions, accounts, verifications, stores, auditLog]) {
      expect(table.id.defaultFn?.()).toMatch(ID_PATTERN);
    }
  });
});
