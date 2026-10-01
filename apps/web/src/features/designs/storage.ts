import 'server-only';
import { storageFromEnvironment, type Storage } from '@pod-studio/core';
const globalForStorage = globalThis as typeof globalThis & { podStudioStorage?: Storage };
export function getStorage(): Storage {
  globalForStorage.podStudioStorage ??= storageFromEnvironment();
  return globalForStorage.podStudioStorage;
}
