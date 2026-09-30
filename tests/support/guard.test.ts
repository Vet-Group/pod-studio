import { describe, expect, it } from 'vitest';
import { assertSafeDatabase, assertSafeDatabaseUrl, assertSafeS3Endpoint, UnsafeTargetError } from './guard';
import { assertTestEnvironment } from './environment';

describe('database guard', () => {
  it.each([
    ['postgres://db.internal:5432/pod_test', 'non-local host'],
    ['postgres://10.0.0.5:5432/pod_test', 'private network host'],
    ['postgres://pod-prod.example.com/pod_test', 'public host'],
    ['postgres://127.0.0.1:5432/pod', 'missing _test suffix'],
    ['postgres://localhost:5432/pod_prod', 'production name'],
    ['postgres://localhost:5432/pod_test_backup_prod', 'suffix not at the end'],
    ['mysql://localhost:3306/pod_test', 'wrong protocol'],
    ['not a url', 'unparseable'],
  ])('refuses %s (%s)', (url) => {
    expect(() => assertSafeDatabaseUrl(url)).toThrow(UnsafeTargetError);
  });

  it.each([
    'postgres://127.0.0.1:54316/pod_test',
    'postgresql://localhost/pod_w1_ab12cd34_test',
    'postgres://[::1]:54316/catalog_test',
  ])('accepts %s', (url) => {
    expect(() => assertSafeDatabaseUrl(url)).not.toThrow();
  });

  it('checks the host even when the database name looks safe', () => {
    expect(() => assertSafeDatabase({ host: 'staging-db', port: 5432, database: 'pod_test' })).toThrow(/localhost/);
  });
});

describe('S3 guard', () => {
  it.each([
    ['https://s3.amazonaws.com', 'AWS'],
    ['https://abc123.r2.cloudflarestorage.com', 'Cloudflare R2'],
    ['http://minio.internal:9000', 'non-local MinIO'],
    ['https://127.0.0.1:19000', 'https is not the local MinIO'],
    ['nope', 'unparseable'],
  ])('refuses %s (%s)', (endpoint) => {
    expect(() => assertSafeS3Endpoint(endpoint)).toThrow(UnsafeTargetError);
  });

  it('accepts the local MinIO from ops/local/docker-compose.yml', () => {
    expect(assertSafeS3Endpoint('http://127.0.0.1:19000').port).toBe('19000');
  });
});

describe('test run environment', () => {
  it('stops the run when DATABASE_URL points at production', () => {
    expect(() => assertTestEnvironment({ DATABASE_URL: 'postgres://prod.example.com/pod' })).toThrow(UnsafeTargetError);
  });

  it('stops the run when the test Postgres host is not local', () => {
    expect(() => assertTestEnvironment({ TEST_PGHOST: 'db.example.com' })).toThrow(UnsafeTargetError);
  });

  it('stops the run when S3_ENDPOINT is a real bucket host', () => {
    expect(() => assertTestEnvironment({ S3_ENDPOINT: 'https://s3.amazonaws.com' })).toThrow(UnsafeTargetError);
  });

  it('passes with the defaults', () => {
    expect(() => assertTestEnvironment({})).not.toThrow();
  });
});
