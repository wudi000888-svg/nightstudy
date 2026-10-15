import { useEffect, useRef } from 'react';

// A shortcut is an explicit navigation intent, never a polling condition. Consume
// it before the first request so failed/empty responses return to manual controls.
export function useQuickStudyStart({
  scope,
  requested,
  ready,
  blocked,
  resumeId,
  consume,
  start,
}: {
  scope: string;
  requested: boolean;
  ready: boolean;
  blocked: boolean;
  resumeId?: string;
  consume: () => void;
  start: (resumeId?: string) => Promise<void>;
}) {
  const attempted = useRef<string | null>(null);
  const callbacks = useRef({ consume, start });
  callbacks.current = { consume, start };
  useEffect(() => {
    if (!requested) {
      attempted.current = null;
      return;
    }
    if (!ready || blocked || attempted.current === scope) return;
    let cancelled = false;
    // StrictMode may immediately clean up the first setup. That cancelled setup
    // must not consume the URL intent or create a request with an expired lifetime.
    void Promise.resolve().then(() => {
      if (cancelled || attempted.current === scope) return;
      attempted.current = scope;
      callbacks.current.consume();
      void callbacks.current.start(resumeId);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, requested, ready, blocked, resumeId]);
}
