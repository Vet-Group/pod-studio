import { describe, expect, it } from 'vitest';
import { uploadDesigns, type UploadApi } from './upload-queue';

const files = [new File(['first'], 'first.png', { type: 'image/png' }), new File(['second'], 'second.png', { type: 'image/png' })];
describe('direct upload queue', () => {
  it('hashes bytes, PUTs directly, finalizes, and creates each design in order', async () => {
    const calls: string[] = [];
    const api: UploadApi = {
      request: async (input) => { calls.push(`request:${input.storeId}`); expect(input.sha256).toMatch(/^[a-f0-9]{64}$/); return { uploadId: 'upload_001', url: 'https://storage.example/upload', headers: { 'Content-Type': input.contentType } }; },
      put: async (url, file) => { calls.push(`put:${file.name}`); expect(url).toBe('https://storage.example/upload'); },
      finalize: async () => { calls.push('finalize'); return { id: 'asset_001' }; },
      create: async (input) => { calls.push(`create:${input.name}`); return { id: input.name }; },
    };
    const results = await uploadDesigns('store_001', files, { api });
    expect(results.map((r) => r.status)).toEqual(['complete', 'complete']);
    expect(calls).toEqual(['request:store_001', 'put:first.png', 'finalize', 'create:first.png', 'request:store_001', 'put:second.png', 'finalize', 'create:second.png']);
  });
  it('does not finalize failed PUTs and keeps later queue items independent', async () => {
    let finalized = 0;
    const api: UploadApi = {
      request: async () => ({ uploadId: 'upload_001', url: 'https://storage.example/upload', headers: {} }),
      put: async (_url, file) => { if (file.name === 'first.png') throw new Error('Upload failed.'); },
      finalize: async () => { finalized++; return { id: 'asset_001' }; },
      create: async () => ({ id: 'design_001' }),
    };
    expect((await uploadDesigns('store_001', files, { api })).map((r) => r.status)).toEqual(['failed', 'complete']);
    expect(finalized).toBe(1);
  });
});
