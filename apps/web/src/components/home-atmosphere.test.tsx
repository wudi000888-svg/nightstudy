import React, { type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { HomeAtmosphere } from './HomeAtmosphere';
import { AdminAppearance, validateWallpaperFile } from './AdminAppearance';
import {
  defaultHomeAppearance,
  homeMotionAllowed,
  homeMotionPreferenceKey,
  localWallpaperUrl,
  readHomeMotionPreference,
  writeHomeMotionPreference,
} from '../lib/home-atmosphere';
import { ApiError, post } from '../lib/api';

const state = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  return {
    scope: 'mount-a:account-a',
    active: true,
    slots: [] as unknown[],
    cursor: 0,
    refs: [] as { current: unknown }[],
    refCursor: 0,
    effects: [] as (() => unknown)[],
    remote: null as unknown,
    queryClient: null as QueryClient | null,
    refetch: vi.fn(),
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.slots))
      state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      state.slots[index],
      (next: unknown) => {
        state.slots[index] = typeof next === 'function' ? next(state.slots[index]) : next;
      },
    ];
  },
  useRef: (initial: unknown) => (state.refs[state.refCursor++] ??= { current: initial }),
  useEffect: (effect: () => unknown) => state.effects.push(effect),
}));
vi.mock('../AppContext', () => ({
  useApp: () => ({ scope: state.scope, user: { id: 'account-a', role: 'admin' } }),
  useRemote: () => ({ data: state.remote, refetch: state.refetch }),
}));
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => state.queryClient,
}));
vi.mock('../lib/screen-lifecycle', () => ({ useScreenActive: () => state.active }));
vi.mock('../lib/api', async (original) => ({
  ...(await original<typeof import('../lib/api')>()),
  post: vi.fn(),
}));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (!React.isValidElement<Record<string, unknown>>(node))
    return Array.isArray(node) ? node.flatMap(elements) : [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function render<T>(component: () => T): T {
  state.cursor = 0;
  state.refCursor = 0;
  state.effects = [];
  return component();
}
function runEffects() {
  return state.effects
    .map((effect) => effect())
    .filter((value): value is () => void => typeof value === 'function');
}
let media: EventTarget & { matches: boolean };
let connection: EventTarget & { saveData: boolean; effectiveType: string };
let page: EventTarget & { visibilityState: string };
let storage: Map<string, string>;
const imageUrl = `/api/v2/appearance/wallpaper/${'a'.repeat(64)}.webp`;
beforeEach(() => {
  vi.stubGlobal('React', React);
  state.scope = 'mount-a:account-a';
  state.active = true;
  state.slots = [];
  state.refs = [];
  state.effects = [];
  state.remote = { appearance: { ...defaultHomeAppearance } };
  state.queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.refetch.mockReset();
  vi.mocked(post).mockReset();
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  media = Object.assign(new EventTarget(), { matches: false });
  connection = Object.assign(new EventTarget(), { saveData: false, effectiveType: '4g' });
  page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), { __NIGHTSTUDY_CONFIG__: {}, matchMedia: () => media }),
  );
  vi.stubGlobal('document', page);
  vi.stubGlobal('navigator', { connection });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-preview');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal(
    'FileReader',
    class {
      result = 'data:image/png;base64,dGVzdA==';
      onload: (() => void) | null = null;
      abort = vi.fn();
      readAsDataURL() {
        this.onload?.();
      }
    },
  );
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('disables animation for reduced motion, data saving, slow connection, hidden and covered pages', () => {
  const value = {
    active: true,
    visible: true,
    reducedMotion: false,
    saveData: false,
    enabled: true,
    siteEnabled: true,
  };
  expect(homeMotionAllowed(value)).toBe(true);
  for (const key of ['active', 'visible', 'enabled', 'siteEnabled'] as const)
    expect(homeMotionAllowed({ ...value, [key]: false })).toBe(false);
  for (const key of ['reducedMotion', 'saveData'] as const)
    expect(homeMotionAllowed({ ...value, [key]: true })).toBe(false);
  for (const effectiveType of ['slow-2g', '2g'])
    expect(homeMotionAllowed({ ...value, effectiveType })).toBe(false);
});

it('reacts to page and network changes, stops immediately under a covering screen, and cleans listeners', () => {
  const component = () => HomeAtmosphere({});
  render(component);
  const cleanup = runEffects();
  expect(render(component).props['data-motion']).toBe('running');
  page.visibilityState = 'hidden';
  page.dispatchEvent(new Event('visibilitychange'));
  expect(render(component).props['data-motion']).toBe('still');
  page.visibilityState = 'visible';
  page.dispatchEvent(new Event('visibilitychange'));
  expect(render(component).props['data-motion']).toBe('running');
  state.active = false;
  const covered = render(component);
  expect(covered.props['data-motion']).toBe('still');
  expect(elements(covered).some((element) => element.props['data-testid'] === 'home-rain')).toBe(
    false,
  );
  state.active = true;
  connection.saveData = true;
  connection.dispatchEvent(new Event('change'));
  expect(render(component).props['data-motion']).toBe('still');
  for (const remove of cleanup) remove();
  connection.saveData = false;
  connection.dispatchEvent(new Event('change'));
  expect(render(component).props['data-motion']).toBe('still');
});

it('does not reuse the preceding account motion preference after a scope change', () => {
  storage.set(homeMotionPreferenceKey(state.scope), 'off');
  render(() => HomeAtmosphere({}));
  runEffects();
  expect(render(() => HomeAtmosphere({})).props['data-motion']).toBe('still');
  state.scope = 'mount-b:account-b';
  render(() => HomeAtmosphere({}));
  runEffects();
  expect(render(() => HomeAtmosphere({})).props['data-motion']).toBe('running');
});

it('keeps the per-account opt-out in memory when browser storage is unavailable', () => {
  vi.stubGlobal('localStorage', {
    getItem() {
      throw new Error('storage disabled');
    },
    setItem() {
      throw new Error('storage disabled');
    },
  });
  writeHomeMotionPreference('storage-disabled:account-a', false);
  expect(readHomeMotionPreference('storage-disabled:account-a')).toBe(false);
  expect(readHomeMotionPreference('storage-disabled:account-b')).toBe(true);
});

it('accepts only exact wallpaper hashes inside the current mount', () => {
  expect(localWallpaperUrl(imageUrl, '')).toBe(imageUrl);
  expect(localWallpaperUrl(`/school${imageUrl}`, '/school')).toBe(`/school${imageUrl}`);
  for (const value of [
    imageUrl,
    `https://example.test/school${imageUrl}`,
    `//evil.test${imageUrl}`,
    `/school${imageUrl}/../secret`,
    `/school${imageUrl}?token=secret`,
    'data:image/png,test',
    'javascript:alert(1)',
  ])
    expect(localWallpaperUrl(value, '/school')).toBeNull();
});

it('falls back to the original rain scene when a custom wallpaper fails to load', () => {
  const appearance = { ...defaultHomeAppearance, mode: 'custom' as const, imageUrl };
  let tree = render(() => HomeAtmosphere({ appearance }));
  const image = elements(tree).find((element) => element.type === 'img')!;
  expect(image.props.src).toBe(imageUrl);
  (image.props.onError as () => void)();
  tree = render(() => HomeAtmosphere({ appearance }));
  expect(elements(tree).some((element) => element.type === 'img')).toBe(false);
  expect(elements(tree).some((element) => element.props.className === 'home-distant-city')).toBe(
    true,
  );
});

it('rejects empty, unsupported and oversized uploads before reading their contents', () => {
  expect(validateWallpaperFile({ type: 'image/png', size: 4 * 1024 * 1024 })).toBeNull();
  for (const file of [
    { type: 'image/png', size: 0 },
    { type: 'image/png', size: 4 * 1024 * 1024 + 1 },
    { type: 'image/svg+xml', size: 120 },
  ])
    expect(validateWallpaperFile(file)).toBeTypeOf('string');
});

it('previews uploads with CSP-permitted data URLs and cleans the image reader on leave', () => {
  render(AdminAppearance);
  runEffects();
  let tree = render(AdminAppearance);
  const input = elements(tree).find(
    (element) => element.type === 'input' && element.props.type === 'file',
  )!;
  (input.props.onChange as (event: unknown) => void)({
    target: { files: [new File(['test'], 'preview.png', { type: 'image/png' })], value: '' },
  });
  render(AdminAppearance);
  const cleanup = runEffects();
  tree = render(AdminAppearance);
  const preview = elements(tree).find((element) => element.type === HomeAtmosphere)!;
  expect(preview.props.previewImageUrl).toBe('data:image/png;base64,dGVzdA==');
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  for (const remove of cleanup) remove();
});

function startAdminUpload() {
  render(AdminAppearance);
  const cleanup = runEffects();
  let tree = render(AdminAppearance);
  const input = elements(tree).find(
    (element) => element.type === 'input' && element.props.type === 'file',
  )!;
  (input.props.onChange as (event: unknown) => void)({
    target: { files: [new File(['test'], 'wallpaper.png', { type: 'image/png' })], value: '' },
  });
  tree = render(AdminAppearance);
  const form = elements(tree).find((element) => element.type === 'form')!;
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  return cleanup;
}
it('saves crop settings with the revision issued by the successful upload and refreshes the home cache', async () => {
  vi.mocked(post).mockResolvedValueOnce({
    appearance: { ...defaultHomeAppearance, mode: 'custom', imageUrl, revision: 1 },
  });
  vi.mocked(post).mockResolvedValueOnce({
    appearance: { ...defaultHomeAppearance, mode: 'custom', imageUrl, revision: 2 },
  });
  startAdminUpload();
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(post).mock.calls[0]?.[1]).toMatchObject({
    expectedRevision: 0,
    dataBase64: 'dGVzdA==',
  });
  expect(vi.mocked(post).mock.calls[1]).toEqual([
    'admin/appearance',
    expect.objectContaining({ expectedRevision: 1, mode: 'custom' }),
    'PUT',
  ]);
  await vi.waitFor(() =>
    expect(
      state.queryClient?.getQueryData([state.scope, 'site-appearance', 'appearance']),
    ).toMatchObject({ appearance: { revision: 2 } }),
  );
});

it('retries failed settings without uploading again or using the stale pre-upload revision', async () => {
  vi.mocked(post).mockResolvedValueOnce({
    appearance: { ...defaultHomeAppearance, mode: 'custom', imageUrl, revision: 1 },
  });
  vi.mocked(post).mockRejectedValueOnce(new ApiError(503, '稍后重试'));
  startAdminUpload();
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  const form = elements(render(AdminAppearance)).find((element) => element.type === 'form')!;
  vi.mocked(post).mockResolvedValueOnce({
    appearance: { ...defaultHomeAppearance, mode: 'custom', imageUrl, revision: 2 },
  });
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(3));
  expect(vi.mocked(post).mock.calls[2]).toEqual([
    'admin/appearance',
    expect.objectContaining({ expectedRevision: 1 }),
    'PUT',
  ]);
});

it('does not apply an upload response or issue the second write after its screen unmounts', async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(post).mockReturnValueOnce(
    new Promise((finish) => {
      resolve = finish;
    }),
  );
  const cleanup = startAdminUpload();
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  for (const remove of cleanup) remove();
  resolve({ appearance: { ...defaultHomeAppearance, mode: 'custom', imageUrl, revision: 1 } });
  await Promise.resolve();
  await Promise.resolve();
  expect(post).toHaveBeenCalledTimes(1);
  expect(
    state.queryClient?.getQueryData([state.scope, 'site-appearance', 'appearance']),
  ).toBeUndefined();
});

it('requires reloading after an optimistic revision conflict instead of repeating the stale write', async () => {
  vi.mocked(post).mockRejectedValueOnce(new ApiError(409, 'conflict', 'appearance_conflict'));
  render(AdminAppearance);
  runEffects();
  let tree = render(AdminAppearance);
  const toggle = elements(tree).find(
    (element) => element.type === 'input' && element.props.type === 'checkbox',
  )!;
  (toggle.props.onChange as (event: unknown) => void)({ target: { checked: false } });
  tree = render(AdminAppearance);
  let form = elements(tree).find((element) => element.type === 'form')!;
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  tree = render(AdminAppearance);
  form = elements(tree).find((element) => element.type === 'form')!;
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  expect(post).toHaveBeenCalledTimes(1);
  expect(
    elements(tree).some(
      (element) => element.props.disabled === true && element.type === 'fieldset',
    ),
  ).toBe(true);
});
