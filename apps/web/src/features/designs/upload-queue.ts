/** Browser-only direct upload pipeline; the full Studio screen consumes this in P1-09. */
export interface UploadApi {
  request(input: { storeId: string; sha256: string; sizeBytes: number; contentType: string }): Promise<{ uploadId: string; url: string; headers: Record<string, string> }>;
  put(url: string, file: File, headers: Record<string, string>, signal?: AbortSignal): Promise<void>;
  finalize(input: { storeId: string; uploadId: string }): Promise<{ id: string }>;
  create(input: { storeId: string; assetId: string; name: string }): Promise<{ id: string }>;
}
export type UploadStatus = 'hashing' | 'uploading' | 'finalizing' | 'complete' | 'failed';
export interface UploadQueueItem { name: string; status: UploadStatus; designId?: string; error?: string }

async function post<T>(operation: string, data: object): Promise<T> {
  const response = await fetch('/api/designs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, ...data }) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error ?? 'The design request failed.');
  return result.data;
}
const browserApi: UploadApi = {
  request: (input) => post('request-upload', input),
  put: async (url, file, headers, signal) => {
    const response = await fetch(url, { method: 'PUT', body: file, headers, signal, credentials: 'omit' });
    if (!response.ok) throw new Error('The file upload failed.');
  },
  finalize: (input) => post('finalize-upload', input),
  create: (input) => post('create', input),
};

/** Sequential and bounded: failed items do not finalize or block subsequent files. */
export async function uploadDesigns(storeId: string, files: readonly File[], options: { api?: UploadApi; signal?: AbortSignal; onProgress?: (item: UploadQueueItem, index: number) => void } = {}): Promise<UploadQueueItem[]> {
  const api = options.api ?? browserApi;
  const results: UploadQueueItem[] = [];
  for (const [index, file] of files.entries()) {
    const update = (status: UploadStatus) => options.onProgress?.({ name: file.name, status }, index);
    try {
      options.signal?.throwIfAborted();
      if (file.size < 1 || file.size > 20 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Choose a PNG, JPEG, WebP or GIF image up to 20 MiB.');
      update('hashing');
      const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
      options.signal?.throwIfAborted();
      const upload = await api.request({ storeId, sha256, sizeBytes: file.size, contentType: file.type });
      update('uploading');
      await api.put(upload.url, file, upload.headers, options.signal);
      options.signal?.throwIfAborted();
      update('finalizing');
      const asset = await api.finalize({ storeId, uploadId: upload.uploadId });
      const design = await api.create({ storeId, assetId: asset.id, name: file.name });
      const item: UploadQueueItem = { name: file.name, status: 'complete', designId: design.id };
      results.push(item);
      options.onProgress?.(item, index);
    } catch (error) {
      const item: UploadQueueItem = { name: file.name, status: 'failed', error: error instanceof Error ? error.message : 'The upload failed.' };
      results.push(item);
      options.onProgress?.(item, index);
    }
  }
  return results;
}
