import { createHash } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AssetError } from './errors';

export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** Trusted server-side adapter. Never expose signing methods without a core scope check. */
export function createStorage(options: { client: S3Client; signingClient?: S3Client; bucket: string; uploadExpiresIn?: number; readExpiresIn?: number }) {
  const { client, bucket } = options;
  const signingClient = options.signingClient ?? client;
  const uploadExpiresIn = options.uploadExpiresIn ?? 300;
  const readExpiresIn = options.readExpiresIn ?? 60;
  for (const seconds of [uploadExpiresIn, readExpiresIn]) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900) throw new AssetError('INVALID_INPUT');
  }
  if (!bucket) throw new AssetError('INVALID_INPUT');
  return {
    uploadExpiresIn,
    async signUpload(key: string, contentType: string) {
      const url = await getSignedUrl(signingClient, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: uploadExpiresIn, signableHeaders: new Set(['content-type']) });
      return { url, headers: { 'Content-Type': contentType }, expiresAt: new Date(Date.now() + uploadExpiresIn * 1000).toISOString() };
    },
    async signRead(key: string, contentType: string) {
      const url = await getSignedUrl(signingClient, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentType: contentType, ResponseContentDisposition: 'inline' }), { expiresIn: readExpiresIn });
      return { url, expiresAt: new Date(Date.now() + readExpiresIn * 1000).toISOString() };
    },
    async readVerified(key: string, declared: { sha256: string; sizeBytes: number; contentType: string }, maxBytes = MAX_ASSET_BYTES) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key })).catch((error: unknown) => {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) throw new AssetError('NOT_FOUND');
        throw error;
      });
      if (!response.Body) throw new AssetError('NOT_FOUND');
      // Read one bounded snapshot, hash it, then write these exact bytes to a different immutable key.
      // CopyObject would race a still-valid PUT URL and could copy unverified replacement bytes.
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > maxBytes || size > declared.sizeBytes) {
          throw new AssetError('SIZE_MISMATCH');
        }
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      if (size !== declared.sizeBytes) throw new AssetError('SIZE_MISMATCH');
      if (response.ContentType !== declared.contentType) throw new AssetError('CONTENT_TYPE_MISMATCH');
      if (createHash('sha256').update(bytes).digest('hex') !== declared.sha256) throw new AssetError('CHECKSUM_MISMATCH');
      return bytes;
    },
    async putVerified(key: string, bytes: Uint8Array, contentType: string) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }));
    },
    async delete(key: string) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
export type Storage = ReturnType<typeof createStorage>;

export function storageFromEnvironment(env: NodeJS.ProcessEnv = process.env): Storage {
  const required = (name: string) => {
    if (!env[name]) throw new Error(`Set ${name} for object storage.`);
    return env[name]!;
  };
  const endpoint = required('S3_ENDPOINT');
  const shared = { region: required('S3_REGION'), forcePathStyle: true,
    credentials: { accessKeyId: required('S3_ACCESS_KEY_ID'), secretAccessKey: required('S3_SECRET_ACCESS_KEY') } };
  const client = new S3Client({ ...shared, endpoint });
  const signingClient = new S3Client({ ...shared, endpoint: env.S3_PUBLIC_ENDPOINT || endpoint });
  return createStorage({ client, signingClient, bucket: required('S3_BUCKET') });
}
