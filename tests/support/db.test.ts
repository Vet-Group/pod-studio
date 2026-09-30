import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseExists, dropOwnedDatabase, type TestDatabase } from './db';
import { createTestBucket, dropOwnedBucket, s3Client, type TestBucket } from './storage';
import { GetObjectCommand, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function db(): Promise<TestDatabase> {
  const d = await createTestDatabase();
  cleanup.push(() => d.drop());
  return d;
}

async function bucket(): Promise<TestBucket> {
  const b = await createTestBucket();
  cleanup.push(() => b.drop());
  return b;
}

describe('test database isolation', () => {
  it('two parallel databases accept the same id without colliding', async () => {
    const [a, b] = await Promise.all([db(), db()]);
    expect(a.database).not.toBe(b.database);
    expect(a.database).toMatch(/^pod_w[a-z0-9]+_[0-9a-f]{8}_test$/);

    for (const d of [a, b]) await d.sql`CREATE TABLE item (id int PRIMARY KEY, owner text NOT NULL)`;
    await Promise.all([
      a.sql`INSERT INTO item (id, owner) VALUES (1, 'a')`,
      b.sql`INSERT INTO item (id, owner) VALUES (1, 'b')`,
    ]);
    const [rowA] = await a.sql<{ owner: string }[]>`SELECT owner FROM item WHERE id = 1`;
    const [rowB] = await b.sql<{ owner: string }[]>`SELECT owner FROM item WHERE id = 1`;
    expect(rowA?.owner).toBe('a');
    expect(rowB?.owner).toBe('b');
  });

  it('runs against Postgres 16', async () => {
    const d = await db();
    const [row] = await d.sql<{ server_version_num: string }[]>`SHOW server_version_num`;
    expect(Math.floor(Number(row?.server_version_num) / 10000)).toBe(16);
  });

  it('drop removes the database it created', async () => {
    const d = await createTestDatabase();
    expect(await databaseExists(d.database)).toBe(true);
    await d.drop();
    expect(await databaseExists(d.database)).toBe(false);
  });

  it('cleanup refuses databases it did not create', async () => {
    const d = await db();
    const other = await createTestDatabase();
    await other.drop();
    // Neither a stranger's name nor an already-dropped database may be dropped by this process.
    expect(await dropOwnedDatabase('postgres')).toBe(false);
    expect(await dropOwnedDatabase('pod_dev')).toBe(false);
    expect(await dropOwnedDatabase(other.database)).toBe(false);
    expect(await databaseExists('postgres')).toBe(true);
    expect(await databaseExists(d.database)).toBe(true);
  });
});

describe('test bucket isolation', () => {
  it('two buckets keep the same key separate and cleanup empties them', async () => {
    const [a, b] = await Promise.all([bucket(), bucket()]);
    expect(a.name).not.toBe(b.name);
    await a.client.send(new PutObjectCommand({ Bucket: a.name, Key: 'design/1.png', Body: 'from-a' }));
    await b.client.send(new PutObjectCommand({ Bucket: b.name, Key: 'design/1.png', Body: 'from-b' }));
    const read = async (t: TestBucket) =>
      (await t.client.send(new GetObjectCommand({ Bucket: t.name, Key: 'design/1.png' }))).Body?.transformToString();
    expect(await read(a)).toBe('from-a');
    expect(await read(b)).toBe('from-b');

    const client = s3Client();
    await a.drop();
    await expect(client.send(new HeadBucketCommand({ Bucket: a.name }))).rejects.toThrow();
    client.destroy();
  });

  it('cleanup refuses buckets it did not create', async () => {
    const client = s3Client();
    expect(await dropOwnedBucket('pod-dev', client)).toBe(false);
    client.destroy();
  });
});
