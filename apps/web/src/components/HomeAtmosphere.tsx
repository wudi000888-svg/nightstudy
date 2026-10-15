import { useEffect, useState, type CSSProperties } from 'react';
import { useApp, useRemote } from '../AppContext';
import { basePath } from '../lib/api';
import {
  defaultHomeAppearance,
  homeMotionAllowed,
  homeMotionPreferenceEvent,
  localWallpaperUrl,
  readHomeMotionPreference,
  writeHomeMotionPreference,
  type HomeAppearance,
} from '../lib/home-atmosphere';
import { useScreenActive } from '../lib/screen-lifecycle';
import './home-atmosphere.css';

interface Connection extends EventTarget {
  saveData?: boolean;
  effectiveType?: string;
}

export function useHomeMotionPreference() {
  const { scope } = useApp();
  const [state, setState] = useState(() => ({ scope, enabled: readHomeMotionPreference(scope) }));
  useEffect(() => {
    const read = () => setState({ scope, enabled: readHomeMotionPreference(scope) });
    read();
    window.addEventListener('storage', read);
    window.addEventListener(homeMotionPreferenceEvent, read);
    return () => {
      window.removeEventListener('storage', read);
      window.removeEventListener(homeMotionPreferenceEvent, read);
    };
  }, [scope]);
  const enabled = state.scope === scope ? state.enabled : readHomeMotionPreference(scope);
  return {
    enabled,
    setEnabled: (next: boolean) => {
      setState({ scope, enabled: next });
      writeHomeMotionPreference(scope, next);
      window.dispatchEvent(new Event(homeMotionPreferenceEvent));
    },
  };
}

function useAtmosphereMotion(siteEnabled: boolean) {
  const active = useScreenActive();
  const preference = useHomeMotionPreference();
  const [permitted, setPermitted] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const connection = (navigator as Navigator & { connection?: Connection }).connection;
    const update = () =>
      setPermitted(
        homeMotionAllowed({
          active,
          visible: document.visibilityState === 'visible',
          reducedMotion: media.matches,
          saveData: !!connection?.saveData,
          effectiveType: connection?.effectiveType,
          enabled: preference.enabled,
          siteEnabled,
        }),
      );
    update();
    document.addEventListener('visibilitychange', update);
    media.addEventListener('change', update);
    connection?.addEventListener('change', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      media.removeEventListener('change', update);
      connection?.removeEventListener('change', update);
    };
  }, [active, preference.enabled, siteEnabled]);
  // A covering page disables movement in the same render, before effects settle.
  return permitted && active && preference.enabled && siteEnabled;
}

export function HomeAtmosphere({
  appearance = defaultHomeAppearance,
  preview = false,
  previewImageUrl,
}: {
  appearance?: HomeAppearance;
  preview?: boolean;
  previewImageUrl?: string;
}) {
  const motion = useAtmosphereMotion(appearance.animationEnabled && !preview);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const localImage = localWallpaperUrl(appearance.imageUrl, basePath);
  const candidate = previewImageUrl ?? localImage;
  const imageUrl = candidate !== failedImage ? candidate : null;
  const custom = appearance.mode === 'custom' && !!imageUrl;
  const style = {
    '--wallpaper-position': `${appearance.positionX}% ${appearance.positionY}%`,
    '--wallpaper-dim': Math.min(0.85, Math.max(0, appearance.overlay)),
  } as CSSProperties;
  return (
    <div
      className={`home-atmosphere${custom ? ' has-wallpaper' : ''}${motion ? ' is-moving' : ''}`}
      style={style}
      aria-hidden="true"
      data-motion={motion ? 'running' : 'still'}
    >
      <div className="home-night-sky" />
      {custom ? (
        <img
          className="home-custom-wallpaper"
          src={imageUrl!}
          alt=""
          decoding="async"
          draggable={false}
          onError={() => setFailedImage(candidate)}
        />
      ) : (
        <>
          <div className="home-moon-halo" />
          <div className="home-distant-city">
            {Array.from({ length: 7 }, (_, index) => (
              <span key={index} />
            ))}
          </div>
          <div className="home-city-glow" />
          <div className="home-window-frame" />
        </>
      )}
      <div className="home-wallpaper-shade" />
      <div className="home-window-droplets" />
      {motion && (
        <div className="home-rain" data-testid="home-rain">
          <span className="home-rain-far" />
          <span className="home-rain-near" />
        </div>
      )}
    </div>
  );
}

export function SiteHomeAtmosphere() {
  const query = useRemote<{ appearance: HomeAppearance }>('site-appearance', 'appearance');
  return <HomeAtmosphere appearance={query.data?.appearance ?? defaultHomeAppearance} />;
}

export function HomeMotionSettings() {
  const { enabled, setEnabled } = useHomeMotionPreference();
  return (
    <label className="mobile-setting-toggle">
      <span>
        <strong>首页动态雨景</strong>
        <small>仅首页轻柔播放。省流、减少动态或切到后台时自动静止；此选择保存在当前设备。</small>
      </span>
      <input
        type="checkbox"
        checked={enabled}
        onChange={(event) => setEnabled(event.target.checked)}
      />
    </label>
  );
}
