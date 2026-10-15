import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export interface AppViewport {
  height: number;
  width: number;
  offsetTop: number;
  offsetLeft: number;
  keyboardOpen: boolean;
}

export function measureAppViewport(): AppViewport {
  if (typeof window === 'undefined')
    return { height: 0, width: 0, offsetTop: 0, offsetLeft: 0, keyboardOpen: false };
  const viewport = window.visualViewport;
  const height = Math.round(viewport?.height ?? window.innerHeight);
  return {
    height,
    width: Math.round(viewport?.width ?? window.innerWidth),
    offsetTop: Math.max(0, Math.round(viewport?.offsetTop ?? 0)),
    offsetLeft: Math.max(0, Math.round(viewport?.offsetLeft ?? 0)),
    keyboardOpen: window.innerHeight - height > 120,
  };
}

const ViewportContext = createContext<AppViewport | null>(null);
export function AppViewportProvider({ children }: { children: ReactNode }) {
  const [viewport, setViewport] = useState(measureAppViewport);
  useEffect(() => {
    let frame = 0;
    const target = window.visualViewport;
    const root = document.documentElement;
    const properties = ['--app-height', '--app-width', '--app-top', '--app-left'] as const;
    const previous = properties.map((name) => root.style.getPropertyValue(name));
    const update = () => {
      frame = 0;
      const value = measureAppViewport();
      root.style.setProperty('--app-height', `${value.height}px`);
      root.style.setProperty('--app-width', `${value.width}px`);
      root.style.setProperty('--app-top', `${value.offsetTop}px`);
      root.style.setProperty('--app-left', `${value.offsetLeft}px`);
      root.dataset.keyboard = value.keyboardOpen ? 'open' : 'closed';
      setViewport((old) =>
        Object.keys(value).every(
          (key) => old[key as keyof AppViewport] === value[key as keyof AppViewport],
        )
          ? old
          : value,
      );
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    target?.addEventListener('resize', schedule);
    target?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      target?.removeEventListener('resize', schedule);
      target?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      properties.forEach((name, index) => {
        if (previous[index]) root.style.setProperty(name, previous[index]);
        else root.style.removeProperty(name);
      });
      delete root.dataset.keyboard;
    };
  }, []);
  return <ViewportContext.Provider value={viewport}>{children}</ViewportContext.Provider>;
}

export function useAppViewport() {
  return useContext(ViewportContext) ?? measureAppViewport();
}
