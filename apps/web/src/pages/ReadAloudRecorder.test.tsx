import React, { type ReactElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReadAloudRecorder } from './ReadAloudRecorder';
import { ErrorNotice } from '../components/UI';
import { stopApplicationAudio } from '../lib/audio-manager';
import { usePageLifetime } from './usePageLifetime';

interface EffectSlot {
  deps: readonly unknown[] | undefined;
  cleanup?: () => void;
}
const state = vi.hoisted(() => ({
  scope: 'recorder-test:learner',
  screenActive: true,
  visibility: 'visible',
  now: 100000,
  states: [] as unknown[],
  stateCursor: 0,
  refs: [] as { current: unknown }[],
  refCursor: 0,
  effects: [] as EffectSlot[],
  effectCursor: 0,
  pending: [] as { index: number; deps: readonly unknown[] | undefined; setup: () => unknown }[],
  callbacks: [] as { deps: readonly unknown[] | undefined; callback: unknown }[],
  callbackCursor: 0,
}));
const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
  !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = state.stateCursor++;
    if (!(index in state.states))
      state.states[index] = typeof initial === 'function' ? initial() : initial;
    return [
      state.states[index],
      (value: unknown) => {
        state.states[index] = typeof value === 'function' ? value(state.states[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => (state.refs[state.refCursor++] ??= { current: initial }),
  useCallback: (callback: unknown, deps: readonly unknown[] | undefined) => {
    const index = state.callbackCursor++;
    if (!state.callbacks[index] || !same(state.callbacks[index].deps, deps))
      state.callbacks[index] = { deps, callback };
    return state.callbacks[index].callback;
  },
  useEffect: (setup: () => unknown, deps: readonly unknown[] | undefined) => {
    const index = state.effectCursor++;
    if (!state.effects[index] || !same(state.effects[index].deps, deps))
      state.pending.push({ index, deps, setup });
  },
}));
vi.mock('../AppContext', () => ({ useApp: () => ({ scope: state.scope }) }));
vi.mock('../lib/screen-lifecycle', () => ({
  screenDeactivateEvent: 'nightstudy-screen-deactivate',
  useScreenActive: () => state.screenActive,
}));
vi.mock('../components/UI', () => ({ ErrorNotice: () => null }));

class FakeTrack {
  stop = vi.fn();
}
class FakeStream {
  tracks = [new FakeTrack(), new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}
const recorders: FakeRecorder[] = [];
class FakeRecorder {
  static isTypeSupported = vi.fn(() => true);
  state = 'inactive';
  mimeType = 'audio/webm';
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  start = vi.fn(() => {
    this.state = 'recording';
  });
  // Browser delivery is asynchronous. Tests choose when an old callback arrives.
  stop = vi.fn(() => {
    this.state = 'inactive';
  });
  constructor(public input: FakeStream) {
    recorders.push(this);
  }
}
const getUserMedia = vi.fn<() => Promise<FakeStream>>();
let documentEvents: EventTarget;
let windowEvents: EventTarget;
let timerSequence = 0;
const timers = new Map<number, () => void>();
const clearInterval = vi.fn((id?: number) => {
  if (id !== undefined) timers.delete(id);
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (!React.isValidElement<Record<string, unknown>>(node))
    return Array.isArray(node) ? node.flatMap(elements) : [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return React.isValidElement<Record<string, unknown>>(node)
    ? text(node.props.children as ReactNode)
    : '';
}
function render<T = ReactElement>(
  component: () => T = (() =>
    ReadAloudRecorder({ text: 'A quiet story.', accent: 'us' })) as () => T,
) {
  state.stateCursor = state.refCursor = state.effectCursor = state.callbackCursor = 0;
  state.pending = [];
  const tree = component();
  const pending = [...state.pending];
  state.pending = [];
  for (const effect of pending) {
    state.effects[effect.index]?.cleanup?.();
    state.effects[effect.index] = { deps: effect.deps };
    const cleanup = effect.setup();
    if (typeof cleanup === 'function') state.effects[effect.index]!.cleanup = cleanup as () => void;
  }
  return tree;
}
function recordButton(tree = render()) {
  const result = elements(tree).find(
    (element) => element.type === 'button' && element.props.className === 'button primary',
  );
  if (!result) throw new Error('Recording control missing');
  return result;
}
function clickRecord() {
  (recordButton().props.onClick as () => void)();
}
function hide(kind: 'screen' | 'document') {
  if (kind === 'screen') {
    state.screenActive = false;
    render();
  } else {
    state.visibility = 'hidden';
    documentEvents.dispatchEvent(new Event('visibilitychange'));
  }
}
function reopen() {
  state.screenActive = true;
  state.visibility = 'visible';
  documentEvents.dispatchEvent(new Event('visibilitychange'));
  render();
}
async function startWith(input: FakeStream) {
  getUserMedia.mockResolvedValueOnce(input);
  clickRecord();
  await settle();
  expect(recordButton().props.children && text(recordButton())).toContain('停止录音');
  return recorders.at(-1)!;
}
function cleanup() {
  for (const effect of state.effects) effect.cleanup?.();
  state.effects = [];
  stopApplicationAudio();
}
beforeEach(() => {
  state.scope = 'recorder-test:learner';
  state.screenActive = true;
  state.visibility = 'visible';
  state.now = 100000;
  state.states = [];
  state.refs = [];
  state.effects = [];
  state.pending = [];
  state.callbacks = [];
  state.stateCursor = state.refCursor = state.effectCursor = state.callbackCursor = 0;
  documentEvents = new EventTarget();
  windowEvents = new EventTarget();
  recorders.length = 0;
  timers.clear();
  timerSequence = 0;
  getUserMedia.mockReset();
  clearInterval.mockClear();
  FakeRecorder.isTypeSupported.mockClear();
  vi.stubGlobal('React', React);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('document', {
    get visibilityState() {
      return state.visibility;
    },
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
  });
  vi.stubGlobal('window', {
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    setInterval: vi.fn((callback: () => void) => {
      const id = ++timerSequence;
      timers.set(id, callback);
      return id;
    }),
    clearInterval,
  });
  vi.spyOn(Date, 'now').mockImplementation(() => state.now);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('Unexpected network: recorder test is fully local')),
  );
});
afterEach(() => {
  cleanup();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(timers.size).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => getUserMedia.mockReset());

it('allows the same retained page owner to settle while hidden without treating it as foreground', () => {
  const page = render(usePageLifetime),
    owner = page.capture();
  state.screenActive = false;
  render(usePageLifetime);
  expect(page.isCurrent(owner)).toBe(true);
  expect(page.isForeground(owner)).toBe(false);
  state.screenActive = true;
  render(usePageLifetime);
  expect(page.isCurrent(owner)).toBe(true);
  expect(page.isForeground(owner)).toBe(true);
  expect(getUserMedia).not.toHaveBeenCalled();
});

it('does not let permission A rejection stop the newer recording B after hiding and reopening', async () => {
  const permissionA = deferred<FakeStream>();
  getUserMedia.mockReturnValueOnce(permissionA.promise);
  clickRecord();
  expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true });
  expect(text(recordButton())).toContain('等待麦克风权限');
  hide('screen');
  reopen();
  const inputB = new FakeStream(),
    recordingB = await startWith(inputB);
  const timerB = [...timers.keys()][0]!;
  permissionA.reject(new Error('A permission denied late'));
  await settle();
  expect(recordingB.state).toBe('recording');
  expect(recordingB.stop).not.toHaveBeenCalled();
  expect(inputB.tracks.every((track) => track.stop.mock.calls.length === 0)).toBe(true);
  expect(timers.has(timerB)).toBe(true);
  expect(
    elements(render()).find((element) => element.type === ErrorNotice)?.props.error,
  ).toBeNull();
  stopApplicationAudio();
  expect(recordingB.stop).toHaveBeenCalledExactlyOnceWith();
});

it.each(['onstop', 'onerror'] as const)(
  'keeps recording B timer and audio ownership when old recording A %s arrives late',
  async (event) => {
    const inputA = new FakeStream(),
      recordingA = await startWith(inputA);
    hide('screen');
    expect(recordingA.stop).toHaveBeenCalledTimes(1);
    expect(inputA.tracks.every((track) => track.stop.mock.calls.length > 0)).toBe(true);
    reopen();
    const inputB = new FakeStream(),
      recordingB = await startWith(inputB);
    const timerB = [...timers.keys()][0]!;
    recordingA[event]!();
    expect(timers.has(timerB)).toBe(true);
    state.now += 2300;
    timers.get(timerB)!();
    expect(text(recordButton())).toContain('停止录音 · 2s');
    expect(inputB.tracks.every((track) => track.stop.mock.calls.length === 0)).toBe(true);
    expect(recordingB.state).toBe('recording');
    expect(
      elements(render()).find((element) => element.type === ErrorNotice)?.props.error,
    ).toBeNull();
    stopApplicationAudio();
    expect(recordingB.stop).toHaveBeenCalledTimes(1);
  },
);

it.each(['screen', 'document'] as const)(
  'stops every owned track on %s hide and immediately disposes a late permission stream',
  async (kind) => {
    const input = new FakeStream(),
      recording = await startWith(input);
    hide(kind);
    expect(recording.stop).toHaveBeenCalledTimes(1);
    expect(input.tracks.every((track) => track.stop.mock.calls.length > 0)).toBe(true);
    expect(timers.size).toBe(0);
    reopen();
    const permission = deferred<FakeStream>();
    getUserMedia.mockReturnValueOnce(permission.promise);
    clickRecord();
    hide(kind);
    const late = new FakeStream();
    permission.resolve(late);
    await settle();
    expect(late.tracks.every((track) => track.stop.mock.calls.length > 0)).toBe(true);
    expect(recorders).toHaveLength(1);
    expect(timers.size).toBe(0);
    reopen();
    expect(recordButton().props.disabled).toBe(false);
    expect(text(recordButton())).toContain('录一段自己的朗读');
  },
);

it('stops a late permission stream without touching an already running newer recorder', async () => {
  const permissionA = deferred<FakeStream>();
  getUserMedia.mockReturnValueOnce(permissionA.promise);
  clickRecord();
  hide('screen');
  reopen();
  const inputB = new FakeStream(),
    recordingB = await startWith(inputB);
  const lateA = new FakeStream();
  permissionA.resolve(lateA);
  await settle();
  expect(lateA.tracks.every((track) => track.stop.mock.calls.length > 0)).toBe(true);
  expect(inputB.tracks.every((track) => track.stop.mock.calls.length === 0)).toBe(true);
  expect(recorders).toHaveLength(1);
  expect(recordingB.state).toBe('recording');
  stopApplicationAudio();
  expect(recordingB.stop).toHaveBeenCalledTimes(1);
});
