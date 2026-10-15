const writes = new Set<symbol>();
const listeners = new Set<() => void>();
const readMethods = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export const activeWriteRequests = () => writes.size;
export function subscribeRequestActivity(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function notify() {
  for (const listener of listeners) listener();
}

/** One token covers fetch and response parsing. It survives navigation/scope changes. */
export function beginWriteRequest(method = 'GET') {
  if (readMethods.has(method.trim().toUpperCase())) return () => {};
  const owner = Symbol('write-request');
  writes.add(owner);
  notify();
  return () => {
    if (!writes.delete(owner)) return;
    notify();
  };
}
