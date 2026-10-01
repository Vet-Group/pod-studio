import { randomBytes } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { assertSafeS3Endpoint } from './guard';

/**
 * Per-worker MinIO buckets for integration tests. Mirrors tests/support/db.ts: every test gets a fresh
 * bucket named `pod-w<worker>-<random>-test`, and cleanup only removes buckets created by this process.
 */

export interface StorageSettings {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function storageSettings(env: NodeJS.ProcessEnv = process.env): StorageSettings {
  return {
    endpoint: env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:19000',
    region: env.TEST_S3_REGION ?? 'us-east-1',
    accessKeyId: env.TEST_S3_ACCESS_KEY_ID ?? 'podlocal',
    secretAccessKey: env.TEST_S3_SECRET_ACCESS_KEY ?? 'pod-local-only',
  };
}

export interface TestBucket {
  name: string;
  client: S3Client;
  /** Empties and deletes the bucket, then closes the client. Safe to call more than once. */
  drop(): Promise<void>;
}

const created = new Set<string>();

export function s3Client(settings: StorageSettings = storageSettings()): S3Client {
  assertSafeS3Endpoint(settings.endpoint);
  return new S3Client({
    endpoint: settings.endpoint,
    region: settings.region,
    forcePathStyle: true,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
  });
}

export async function createTestBucket(settings: StorageSettings = storageSettings(), requestedName?: string): Promise<TestBucket> {
  const worker = (process.env.VITEST_POOL_ID ?? '0').replace(/[^a-z0-9]/gi, '').toLowerCase() || '0';
  const name = requestedName ?? `pod-w${worker}-${randomBytes(4).toString('hex')}-test`;
  if (!/^pod-[a-z0-9-]+-test$/.test(name) || name.length > 63) throw new Error('Refusing a non-test bucket name.');
  const client = s3Client(settings);
  await client.send(new CreateBucketCommand({ Bucket: name }));
  created.add(name);

  let dropped = false;
  return {
    name,
    client,
    async drop() {
      if (dropped) return;
      dropped = true;
      try {
        await dropOwnedBucket(name, client);
      } finally {
        client.destroy();
      }
    },
  };
}

/** Empties and deletes a bucket only if this process created it. Returns false when it refused. */
export async function dropOwnedBucket(name: string, client: S3Client): Promise<boolean> {
  if (!created.has(name)) return false;
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: name, ContinuationToken: token }));
    const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (keys.length) await client.send(new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: keys } }));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  await client.send(new DeleteBucketCommand({ Bucket: name }));
  created.delete(name);
  return true;
}
