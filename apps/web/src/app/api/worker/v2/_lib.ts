import { createWorkerApi } from '@/features/workers/handler';
import { getDatabase } from '@/lib/auth';
import { getStorage } from '@/features/designs/storage';

export const workerApi = createWorkerApi({ database: getDatabase, storage: getStorage });
