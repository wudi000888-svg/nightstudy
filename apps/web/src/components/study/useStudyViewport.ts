import { useEffect, useState } from 'react';

export function useStudyViewport(active: boolean) {
  const [height, setHeight] = useState<number | undefined>();
  useEffect(() => {
    if (!active) {
      setHeight(undefined);
      return;
    }
    const viewport = window.visualViewport;
    const update = () => setHeight(Math.round(viewport?.height ?? window.innerHeight));
    update();
    viewport?.addEventListener('resize', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
    };
  }, [active]);
  return height;
}
