import type { Location } from 'react-router-dom';
import { locationHref, type NavigationAction } from './app-navigation-state';

export interface TransitionScreen {
  id: string;
  location: Location;
  kind: 'home' | 'module' | 'study';
}
export interface ScreenTransition {
  id: number;
  from: TransitionScreen;
  to: TransitionScreen;
  kind: 'open' | 'close' | 'forward' | 'back' | 'content' | 'study-enter' | 'study-exit';
  duration: number;
}
export type TransitionRole = 'incoming' | 'outgoing';

/** Transition ownership only controls drawing. It never queues a route or a save. */
export class ScreenTransitionState {
  current: ScreenTransition | null = null;
  private epoch = 0;

  begin(
    from: TransitionScreen | null,
    to: TransitionScreen,
    action: NavigationAction,
    reduced = false,
  ) {
    this.reset();
    if (
      !from ||
      reduced ||
      // A session URL/phase replacement owns its own lifecycle. In particular,
      // same-URL POP must not keep an old study tree alive while a save resolves.
      (from.kind === 'study' && to.kind === 'study') ||
      (from.location.key === to.location.key &&
        locationHref(from.location) === locationHref(to.location))
    )
      return null;
    const kind =
      to.kind === 'study'
        ? 'study-enter'
        : from.kind === 'study'
          ? 'study-exit'
          : to.kind === 'home'
            ? 'close'
            : from.kind === 'home'
              ? 'open'
              : from.id === to.id
                ? 'content'
                : action === 'POP'
                  ? 'back'
                  : 'forward';
    this.current = {
      id: this.epoch,
      from,
      to,
      kind,
      duration:
        kind === 'study-enter'
          ? 200
          : kind === 'study-exit'
            ? 180
            : kind === 'open'
              ? 240
              : kind === 'close'
                ? 210
                : kind === 'content'
                  ? 180
                  : 220,
    };
    return this.current;
  }
  finish(id: number) {
    if (this.current?.id !== id) return false;
    this.current = null;
    return true;
  }
  reset() {
    this.epoch++;
    this.current = null;
  }
}

export function screenTransitionFrames(
  transition: ScreenTransition,
  role: TransitionRole,
): Keyframe[] | null {
  // Draw only the newly active screen. The previous study subtree is discarded
  // immediately, so motion cannot restart requests, playback or pending ratings.
  if (transition.kind === 'study-enter' || transition.kind === 'study-exit')
    return role === 'incoming'
      ? [
          {
            opacity: 0.7,
            transform:
              transition.kind === 'study-enter'
                ? 'translate3d(12%, 0, 0)'
                : 'translate3d(-12%, 0, 0)',
          },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        ]
      : null;
  if (transition.kind === 'content')
    return role === 'incoming'
      ? [
          { opacity: 0.6, transform: 'translate3d(0, 12px, 0)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        ]
      : null;
  if (transition.kind === 'open')
    return role === 'incoming'
      ? [
          { opacity: 0.94, transform: 'translate3d(0, 100%, 0)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        ]
      : null;
  if (transition.kind === 'close')
    return role === 'outgoing'
      ? [
          { opacity: 1, transform: 'translate3d(0, 0, 0)' },
          { opacity: 0.92, transform: 'translate3d(0, 100%, 0)' },
        ]
      : null;
  if (transition.kind === 'forward')
    return role === 'incoming'
      ? [
          { opacity: 0.96, transform: 'translate3d(100%, 0, 0)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        ]
      : [
          { opacity: 1, transform: 'translate3d(0, 0, 0)' },
          { opacity: 0.65, transform: 'translate3d(-18%, 0, 0)' },
        ];
  return role === 'outgoing'
    ? [
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        { opacity: 0.96, transform: 'translate3d(100%, 0, 0)' },
      ]
    : [
        { opacity: 0.65, transform: 'translate3d(-18%, 0, 0)' },
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
      ];
}

export function animateScreenTransition(
  element: HTMLElement,
  transition: ScreenTransition,
  role: TransitionRole,
) {
  const frames = screenTransitionFrames(transition, role);
  if (!frames) return () => {};
  if (typeof element.animate === 'function') {
    const animation = element.animate(frames, {
      duration: transition.duration,
      easing: 'cubic-bezier(.22,.8,.22,1)',
      fill: 'both',
    });
    return () => animation.cancel();
  }
  // Web Animations is progressive; CSS retains the same gestures on older WebKit.
  const oldAnimation = element.style.animation;
  element.style.animation = 'none';
  element.getBoundingClientRect();
  element.style.animation = `h5-${transition.kind}-${role} ${transition.duration}ms cubic-bezier(.22,.8,.22,1) both`;
  return () => {
    element.style.animation = oldAnimation;
  };
}
