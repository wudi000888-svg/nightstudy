import { useEffect, useRef } from 'react';
import { useApp } from '../AppContext';

export function usePageLifetime(route = '') {
  const { scope } = useApp();
  const current = useRef({ scope, route });
  current.current = { scope, route };
  const lifetime = useRef(0);
  useEffect(() => {
    lifetime.current++;
    return () => {
      lifetime.current++;
    };
  }, [scope, route]);
  return {
    scope,
    capture: () => ({ scope, route, value: lifetime.current }),
    isCurrent: (owner: { scope: string; route: string; value: number }) =>
      current.current.scope === owner.scope &&
      current.current.route === owner.route &&
      lifetime.current === owner.value,
  };
}
