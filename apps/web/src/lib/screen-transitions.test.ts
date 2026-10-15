import { describe, expect, it, vi } from 'vitest';
import {
  animateScreenTransition,
  ScreenTransitionState,
  screenTransitionFrames,
  type TransitionScreen,
} from './screen-transitions';

function screen(
  path: string,
  key: string,
  kind: TransitionScreen['kind'] = 'module',
): TransitionScreen {
  const url = new URL(path, 'https://motion.test');
  return {
    id: kind === 'home' ? 'home' : kind === 'study' ? 'study' : url.pathname,
    kind,
    location: { pathname: url.pathname, search: url.search, hash: url.hash, key, state: null },
  };
}

describe('application transition ownership', () => {
  it('draws a real module close immediately and rejects its stale completion after a new navigation intent', () => {
    const state = new ScreenTransitionState();
    const home = screen('/', 'home', 'home');
    const closing = state.begin(screen('/notes', 'notes'), home, 'POP')!;
    expect(closing.kind).toBe('close');
    expect(closing.duration).toBe(210);
    expect(state.current?.to).toBe(home);
    const reopening = state.begin(home, screen('/academy', 'new-intent'), 'PUSH')!;
    expect(state.finish(closing.id)).toBe(false);
    expect(state.current).toBe(reopening);
    expect(state.current?.to.location.pathname).toBe('/academy');
    expect(state.finish(reopening.id)).toBe(true);
    expect(state.current).toBeNull();
    expect(state.finish(reopening.id)).toBe(false);
  });

  it('drops every old private transition snapshot on scope teardown and skips study, initial and reduced-motion transitions', () => {
    const state = new ScreenTransitionState();
    const privatePage = screen('/notes?note=account-a', 'private-a');
    const outgoing = state.begin(privatePage, screen('/', 'home', 'home'), 'POP')!;
    state.reset();
    expect(state.current).toBeNull();
    expect(state.finish(outgoing.id)).toBe(false);
    expect(state.begin(null, privatePage, 'POP')).toBeNull();
    expect(state.begin(privatePage, screen('/me', 'account-b'), 'PUSH', true)).toBeNull();
    expect(
      state.begin(privatePage, screen('/learn?session=issued', 'task', 'study'), 'PUSH'),
    ).toBeNull();
    expect(state.current).toBeNull();
  });

  it('uses matching browser back motion for child screens and a short content transition without replacing the same page identity', () => {
    const state = new ScreenTransitionState();
    const content = screen('/content', 'content');
    const notes = screen('/notes', 'notes');
    expect(state.begin(content, notes, 'PUSH')?.kind).toBe('forward');
    const back = state.begin(notes, content, 'POP')!;
    expect(back.kind).toBe('back');
    expect(screenTransitionFrames(back, 'outgoing')?.at(-1)?.transform).toContain('100%');
    const lesson = state.begin(
      screen('/academy?lesson=one', 'lesson-one'),
      screen('/academy?lesson=two', 'lesson-two'),
      'PUSH',
    )!;
    expect(lesson.kind).toBe('content');
    expect(lesson.duration).toBe(180);
    expect(lesson.from.id).toBe(lesson.to.id);
  });

  it('cancels the actual native animation when a screen is replaced or unmounted instead of leaving a frozen transform', () => {
    const state = new ScreenTransitionState();
    const opening = state.begin(
      screen('/', 'home', 'home'),
      screen('/content', 'content'),
      'PUSH',
    )!;
    const cancel = vi.fn();
    const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({
      cancel,
    }));
    const element = { animate } as unknown as HTMLElement;
    const cleanup = animateScreenTransition(element, opening, 'incoming');
    expect(animate).toHaveBeenCalledOnce();
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 240, fill: 'both' });
    expect(cancel).not.toHaveBeenCalled();
    cleanup();
    expect(cancel).toHaveBeenCalledOnce();
    expect(state.finish(opening.id)).toBe(true);
  });
});
