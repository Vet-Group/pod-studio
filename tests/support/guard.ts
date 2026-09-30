/**
 * Production guard for tests. Every test helper that touches a database or bucket calls these
 * first, so a mis-set environment variable can never point a test run at shared or production data.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class UnsafeTargetError extends Error {
  override name = 'UnsafeTargetError';
}

export interface DatabaseTarget {
  host: string;
  port: number;
  database: string;
}

/** Test databases must live on a loopback host and carry a `_test` suffix. */
export function assertSafeDatabase(target: DatabaseTarget): void {
  if (!LOCAL_HOSTS.has(target.host.toLowerCase())) {
    throw new UnsafeTargetError(`Refusing database host "${target.host}": tests only run against localhost.`);
  }
  if (!/^[a-z0-9_]+_test$/.test(target.database)) {
    throw new UnsafeTargetError(`Refusing database "${target.database}": test databases must end in "_test".`);
  }
}

/** Parses a postgres:// URL and applies {@link assertSafeDatabase}. */
export function assertSafeDatabaseUrl(url: string): DatabaseTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeTargetError('Refusing database URL: it is not a valid URL.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new UnsafeTargetError(`Refusing database URL with protocol "${parsed.protocol}".`);
  }
  const target: DatabaseTarget = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };
  assertSafeDatabase(target);
  return target;
}

/** Test buckets must be served by the local MinIO from ops/local/docker-compose.yml. */
export function assertSafeS3Endpoint(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new UnsafeTargetError('Refusing S3 endpoint: it is not a valid URL.');
  }
  if (parsed.protocol !== 'http:') {
    throw new UnsafeTargetError(`Refusing S3 endpoint "${parsed.origin}": local MinIO is plain http.`);
  }
  if (!LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new UnsafeTargetError(`Refusing S3 endpoint "${parsed.origin}": tests only use the local MinIO.`);
  }
  return parsed;
}
