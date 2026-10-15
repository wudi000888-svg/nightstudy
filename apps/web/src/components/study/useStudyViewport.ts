import { useAppViewport } from '../AppViewport';

export function useStudyViewport(active: boolean) {
  const viewport = useAppViewport();
  return active && viewport.height > 0 ? viewport.height : undefined;
}
