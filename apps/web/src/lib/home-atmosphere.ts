/** Public appearance data contains only a local, server-validated wallpaper. */
export interface HomeAppearance {
  mode: 'rain-night' | 'custom';
  imageUrl: string | null;
  positionX: number;
  positionY: number;
  overlay: number;
  animationEnabled: boolean;
  revision: number;
}

export const defaultHomeAppearance: HomeAppearance = {
  mode: 'rain-night',
  imageUrl: null,
  positionX: 50,
  positionY: 50,
  overlay: 0.4,
  animationEnabled: true,
  revision: 0,
};

export function homeMotionAllowed(value: {
  active: boolean;
  visible: boolean;
  reducedMotion: boolean;
  saveData: boolean;
  effectiveType?: string;
  enabled: boolean;
  siteEnabled: boolean;
}) {
  return (
    value.active &&
    value.visible &&
    !value.reducedMotion &&
    !value.saveData &&
    !['slow-2g', '2g'].includes(value.effectiveType ?? '') &&
    value.enabled &&
    value.siteEnabled
  );
}

export const homeMotionPreferenceKey = (scope: string) => `nightstudy:home-motion:${scope}`;
export const homeMotionPreferenceEvent = 'nightstudy-home-motion-change';
const sessionPreferences = new Map<string, boolean>();

export function readHomeMotionPreference(scope: string) {
  try {
    const stored = localStorage.getItem(homeMotionPreferenceKey(scope));
    return stored === null ? (sessionPreferences.get(scope) ?? true) : stored !== 'off';
  } catch {
    return sessionPreferences.get(scope) ?? true;
  }
}

export function writeHomeMotionPreference(scope: string, enabled: boolean) {
  sessionPreferences.delete(scope);
  sessionPreferences.set(scope, enabled);
  if (sessionPreferences.size > 32)
    sessionPreferences.delete(sessionPreferences.keys().next().value!);
  try {
    localStorage.setItem(homeMotionPreferenceKey(scope), enabled ? 'on' : 'off');
  } catch {
    // A bounded in-memory choice still reaches the retained Home in this tab.
  }
}

/** Reject external/active URLs even if a compromised response reaches the renderer. */
export function localWallpaperUrl(imageUrl: string | null | undefined, basePath: string) {
  if (!imageUrl) return null;
  const prefix = `${basePath}/api/v2/appearance/wallpaper/`;
  return imageUrl.startsWith(prefix) && /^[a-f0-9]{64}\.webp$/.test(imageUrl.slice(prefix.length))
    ? imageUrl
    : null;
}
