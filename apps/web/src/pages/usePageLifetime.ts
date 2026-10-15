import { useEffect, useRef } from 'react';
import { useApp } from '../AppContext';
import { useScreenActive } from '../lib/screen-lifecycle';

interface PageOwner {
  scope: string;
  route: string;
  value: number;
}

export function usePageLifetime(route = '') {
  const { scope } = useApp();
  const active = useScreenActive();
  const current = useRef({ scope, route, active });
  current.current = { scope, route, active };
  const lifetime = useRef(0);
  useEffect(() => {
    lifetime.current++;
    return () => {
      lifetime.current++;
    };
  }, [scope, route]);
  const isCurrent = (owner: PageOwner) =>
    current.current.scope === owner.scope &&
    current.current.route === owner.route &&
    lifetime.current === owner.value;
  return {
    scope,
    active,
    capture: () => ({ scope, route, value: lifetime.current }),
    // Hiding a retained screen does not invalidate an already-authorized save.
    // Its state/cache and busy cleanup must still settle for the same owner.
    isCurrent,
    isForeground: (owner: PageOwner) => current.current.active && isCurrent(owner),
  };
}
