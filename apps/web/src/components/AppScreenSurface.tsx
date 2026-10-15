import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { AppScreen } from './AppNavigation';
import { H5ScreenHeader } from './Shell';
import { animateScreenTransition } from '../lib/screen-transitions';

export function AppScreenSurface({ screen, children }: { screen: AppScreen; children: ReactNode }) {
  const element = useRef<HTMLElement>(null);
  const motion = screen.transition;
  const role = screen.transitionRole;
  useLayoutEffect(() => {
    if (!element.current || !motion || !role) return;
    return animateScreenTransition(element.current, motion, role);
  }, [motion?.id, role]);
  return (
    <section
      ref={element}
      className={`h5-screen h5-${screen.kind}-screen`}
      hidden={!(screen.visible ?? screen.active)}
      inert={!screen.active}
      aria-hidden={!screen.active}
      data-screen-id={screen.id}
      data-screen-active={screen.active}
      data-motion={motion && role ? `${motion.kind}-${role}` : undefined}
    >
      {screen.kind === 'module' && <H5ScreenHeader location={screen.location} />}
      <div className="h5-screen-content">{children}</div>
    </section>
  );
}
