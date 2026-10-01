'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * False during server render and hydration, true once React owns the page. Auth forms keep submit
 * disabled until then: a native submit before hydration would send the passwords as a GET query
 * string, into the address bar, history and server logs.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
