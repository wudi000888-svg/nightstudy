import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApp } from './AppContext';
import { ApiError, api, post } from './lib/api';

export interface LearningPreferences {
  theme: 'day' | 'night' | 'system';
  accent: 'us' | 'uk';
  autoPlay: boolean;
  spellingEnabled: boolean;
  fontScale: 1 | 1.125 | 1.25;
  reminderEnabled: boolean;
  reminderTime: string;
  revision: number;
}

export const defaultLearningPreferences: LearningPreferences = {
  theme: 'day',
  accent: 'us',
  autoPlay: false,
  spellingEnabled: true,
  fontScale: 1,
  reminderEnabled: false,
  reminderTime: '20:00',
  revision: 0,
};

export type LearningPreferencePatch = Partial<Omit<LearningPreferences, 'revision'>>;
interface PreferencesState {
  preferences: LearningPreferences;
  loaded: boolean;
  saving: boolean;
  error: unknown;
  savePreferences: (patch: LearningPreferencePatch) => Promise<boolean>;
  reloadPreferences: () => Promise<void>;
  resetError: () => void;
}

const Context = createContext<PreferencesState>({
  preferences: defaultLearningPreferences,
  loaded: false,
  saving: false,
  error: null,
  savePreferences: async () => false,
  reloadPreferences: async () => {},
  resetError: () => {},
});
export const useLearningPreferences = () => useContext(Context);

function guestPreferences(key: string): LearningPreferences {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!stored || typeof stored !== 'object') return { ...defaultLearningPreferences };
    const value = stored as Record<string, unknown>;
    return {
      ...defaultLearningPreferences,
      ...(value.theme === 'day' || value.theme === 'night' || value.theme === 'system'
        ? { theme: value.theme }
        : {}),
      ...(value.accent === 'us' || value.accent === 'uk' ? { accent: value.accent } : {}),
      ...(value.fontScale === 1 || value.fontScale === 1.125 || value.fontScale === 1.25
        ? { fontScale: value.fontScale }
        : {}),
    };
  } catch {
    return { ...defaultLearningPreferences };
  }
}

function PreferencesScope({ children }: { children: ReactNode }) {
  const { scope, site, user } = useApp();
  const queryClient = useQueryClient();
  const guestKey = `nightstudy:guest-appearance:${site.siteId}`;
  const [guest, setGuest] = useState(() => guestPreferences(guestKey));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const savingRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const queryKey = [scope, 'learning-preferences'];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      api<{ preferences: LearningPreferences }>('learning-preferences', { signal }),
    enabled: !!user && !saving,
    retry: false,
    staleTime: 60000,
  });
  const preferences = user ? (query.data?.preferences ?? defaultLearningPreferences) : guest;

  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const theme =
        preferences.theme === 'system' ? (media.matches ? 'night' : 'day') : preferences.theme;
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.appearance = preferences.theme;
      document.documentElement.style.setProperty('--learning-scale', String(preferences.fontScale));
      const color = theme === 'night' ? '#14201f' : '#edf2ef';
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preferences.theme, preferences.fontScale]);

  async function savePreferences(patch: LearningPreferencePatch) {
    if (savingRef.current) return false;
    if (!user) {
      const next = { ...guest, ...patch, revision: guest.revision + 1 };
      setGuest(next);
      try {
        localStorage.setItem(
          guestKey,
          JSON.stringify({ theme: next.theme, accent: next.accent, fontScale: next.fontScale }),
        );
      } catch {
        // Appearance still works when browser storage is unavailable.
      }
      return true;
    }
    if (!query.data) {
      setError(new Error('正在读取你的学习偏好，请稍后重试。'));
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await queryClient.cancelQueries({ queryKey });
      if (!alive.current) return false;
      const current = queryClient.getQueryData<{ preferences: LearningPreferences }>(queryKey);
      if (!current) throw new Error('请重新读取学习偏好后再保存。');
      const result = await post<{ preferences: LearningPreferences }>(
        'learning-preferences',
        { expectedRevision: current.preferences.revision, ...patch },
        'PUT',
      );
      if (!alive.current) return false;
      queryClient.setQueryData(queryKey, result);
      return true;
    } catch (value) {
      if (!alive.current) return false;
      if (value instanceof ApiError && value.status === 409) await query.refetch();
      if (alive.current) setError(value);
      return false;
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }

  return (
    <Context.Provider
      value={{
        preferences,
        loaded: !user || !!query.data,
        saving,
        error: error ?? query.error,
        savePreferences,
        reloadPreferences: async () => {
          if (savingRef.current) return;
          setError(null);
          if (user) await query.refetch();
        },
        resetError: () => setError(null),
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function LearningPreferencesProvider({ children }: { children: ReactNode }) {
  const { scope } = useApp();
  return <PreferencesScope key={scope}>{children}</PreferencesScope>;
}
