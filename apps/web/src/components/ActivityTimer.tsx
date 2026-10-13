import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useApp } from '../AppContext';
import { newId, post } from '../lib/api';

// Only recent foreground interaction contributes; offline intervals are not invented.
export function ActivityTimer() {
  const { user } = useApp();
  const { pathname } = useLocation();
  useEffect(() => {
    if (!user || !['/learn', '/review', '/assessment', '/lookup', '/wordbook'].includes(pathname))
      return;
    let lastInteraction = Date.now();
    let lastTick = Date.now();
    const interacted = () => {
      lastInteraction = Date.now();
    };
    window.addEventListener('pointerdown', interacted);
    window.addEventListener('keydown', interacted);
    const timer = window.setInterval(() => {
      const now = Date.now();
      const start = Math.max(lastTick, now - 15000);
      lastTick = now;
      if (
        document.visibilityState !== 'visible' ||
        now - lastInteraction >= 60000 ||
        !navigator.onLine ||
        now - start < 1000
      )
        return;
      void post('activity', {
        eventId: newId(),
        startAt: new Date(start).toISOString(),
        endAt: new Date(now).toISOString(),
      }).catch(() => {});
    }, 15000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pointerdown', interacted);
      window.removeEventListener('keydown', interacted);
    };
  }, [user?.id, pathname]);
  return null;
}
