import { describe, expect, it } from 'vitest';
import { storageFromEnvironment } from '../../src/assets/storage';

const settings = {
  S3_ENDPOINT: 'http://minio:9000', S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: 'local-test-key',
  S3_SECRET_ACCESS_KEY: 'local-test-secret', S3_BUCKET: 'pod-storage-test',
};
describe('environment storage signing', () => {
  it('signs browser capabilities at the optional public endpoint with path-style keys', async () => {
    const storage = storageFromEnvironment({ ...settings, S3_PUBLIC_ENDPOINT: 'https://app.example' });
    const put = await storage.signUpload('stores/store_001/uploads/upload_001', 'image/png');
    const get = await storage.signRead('stores/store_001/assets/asset_001', 'image/png');
    for (const signed of [put, get]) {
      const url = new URL(signed.url);
      expect(url.origin).toBe('https://app.example');
      expect(url.pathname).toMatch(/^\/pod-storage-test\/stores\/store_001\//);
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('host');
    }
  });
  it('falls back to the server endpoint when no public endpoint is set', async () => {
    const url = new URL((await storageFromEnvironment(settings).signRead('stores/store_001/assets/asset_001', 'image/png')).url);
    expect(url.origin).toBe('http://minio:9000');
    expect(url.pathname).toBe('/pod-storage-test/stores/store_001/assets/asset_001');
  });
});
