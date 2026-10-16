import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate, useNavigationType, type Location } from 'react-router-dom';
import {
  AppNavigationState,
  AppScreenCache,
  committedHistoryIndex,
  locationHref,
} from '../lib/app-navigation-state';
import { basePath } from '../lib/api';
import { isStudyPath, screenIdentity, screenModule, type AppModule } from '../lib/navigation';
import {
  consumeTopLayer,
  createAppBackHandler,
  registerAppBackHandler,
  screenDeactivateEvent,
} from '../lib/screen-lifecycle';
import {
  ScreenTransitionState,
  type ScreenTransition,
  type TransitionRole,
  type TransitionScreen,
} from '../lib/screen-transitions';

export interface AppScreen {
  id: string;
  location: Location;
  active: boolean;
  kind: 'home' | 'module' | 'study';
  visible?: boolean;
  transition?: ScreenTransition;
  transitionRole?: TransitionRole;
}
interface AppNavigation {
  screens: AppScreen[];
  activeModule: AppModule | null;
  canGoBack: boolean;
  openModule: (module: AppModule) => void;
  closeModule: () => void;
  goBack: () => void;
  exitStudy: () => void;
  transitioning: boolean;
}

const NavigationContext = createContext<AppNavigation | null>(null);
const home: Location = { pathname: '/', search: '', hash: '', state: null, key: 'home' };
const historyIndex = () => Number(window.history.state?.idx ?? 0);

export function AppNavigationProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const action = useNavigationType();
  const navigate = useNavigate();
  const state = useRef(new AppNavigationState());
  const retained = useRef(new AppScreenCache(home));
  const transitions = useRef(new ScreenTransitionState());
  const previousScreen = useRef<TransitionScreen | null>(null);
  const [transition, setTransition] = useState<ScreenTransition | null>(null);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  const pendingRestore = useRef<string | null>(null);
  const pendingBack = useRef(false);
  const current = useRef({ location, index: historyIndex() });
  const currentIdentity = screenIdentity(location.pathname);
  const module = screenModule(location.pathname);
  const index = committedHistoryIndex(
    current.current,
    location,
    {
      index: historyIndex(),
      href: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    },
    basePath,
  );
  const restoringModule = pendingRestore.current === locationHref(location);
  state.current.visit(location, action, index, restoringModule);
  if (restoringModule) pendingRestore.current = null;
  current.current = { location, index };
  retained.current.visit(location);
  const screens = [...retained.current.locations.entries()].map(([id, value]): AppScreen => ({
    id,
    location: value,
    active: id === currentIdentity,
    kind: id === 'home' ? 'home' : 'module',
  }));
  if (!retained.current.retains(location.pathname)) {
    screens.push({
      id: currentIdentity,
      location,
      active: true,
      kind: isStudyPath(location.pathname) ? 'study' : 'module',
    });
  }
  if (
    transition &&
    transition.from.id !== currentIdentity &&
    transition.from.kind === 'module' &&
    !screens.some((screen) => screen.id === transition.from.id)
  ) {
    screens.push({ ...transition.from, active: false });
  }
  for (const screen of screens) {
    screen.visible =
      screen.active ||
      (screen.kind === 'home' && !isStudyPath(location.pathname)) ||
      (!!transition && transition.from.id === screen.id && transition.from.kind === 'module');
    if (transition?.to.id === screen.id) {
      screen.transition = transition;
      screen.transitionRole = 'incoming';
    } else if (transition?.from.id === screen.id) {
      screen.transition = transition;
      screen.transitionRole = 'outgoing';
    }
  }

  useLayoutEffect(() => {
    const nextScreen: TransitionScreen = {
      id: currentIdentity,
      location,
      kind:
        location.pathname === '/' ? 'home' : isStudyPath(location.pathname) ? 'study' : 'module',
    };
    const next = transitions.current.begin(
      previousScreen.current,
      nextScreen,
      pendingBack.current ? 'POP' : action,
      reducedMotion,
    );
    pendingBack.current = false;
    previousScreen.current = nextScreen;
    setTransition(next);
    if (!next) return;
    const timer = window.setTimeout(() => {
      if (transitions.current.finish(next.id)) setTransition(null);
    }, next.duration);
    return () => window.clearTimeout(timer);
  }, [location.key, location.pathname, location.search, location.hash, reducedMotion]);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const change = () => setReducedMotion(query?.matches ?? false);
    const hidden = () => {
      if (document.visibilityState === 'hidden') {
        transitions.current.reset();
        setTransition(null);
      }
    };
    query?.addEventListener('change', change);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      transitions.current.reset();
      query?.removeEventListener('change', change);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

  function closeModule() {
    if (consumeTopLayer()) return;
    if (location.pathname === '/') return;
    const distance = state.current.homeDistance(historyIndex());
    if (distance) navigate(-distance);
    else navigate('/', { replace: true });
  }
  function goBack() {
    if (consumeTopLayer()) return;
    if (isStudyPath(location.pathname) && state.current.history.has(historyIndex() - 1)) {
      navigate(-1);
      return;
    }
    if (location.pathname === '/admin' || location.pathname.startsWith('/admin/')) {
      if (state.current.history.has(historyIndex() - 1)) navigate(-1);
      else {
        pendingBack.current = true;
        navigate('/me', { replace: true });
      }
      return;
    }
    if (module) {
      const previous = state.current.previous(module);
      if (previous) {
        if (state.current.canPopTo(previous, historyIndex())) navigate(-1);
        else {
          state.current.takePrevious(module);
          const target = locationHref(previous);
          pendingRestore.current = target;
          pendingBack.current = true;
          navigate(target, { replace: true });
        }
        return;
      }
    }
    const distance = state.current.homeDistance(historyIndex());
    if (distance) navigate(-distance);
    else navigate('/', { replace: true });
  }

  useLayoutEffect(() => {
    const pop = createAppBackHandler(
      () => ({ index: current.current.index, key: current.current.location.key }),
      (delta) => window.history.go(delta),
    );
    return registerAppBackHandler(pop);
  }, []);

  useLayoutEffect(() => {
    window.dispatchEvent(
      new CustomEvent(screenDeactivateEvent, { detail: { activeScreen: currentIdentity } }),
    );
    // Native lesson players can survive hidden DOM. A hidden screen never owns sound.
    document
      .querySelectorAll<HTMLMediaElement>('.h5-screen[inert] audio, .h5-screen[inert] video')
      .forEach((media) => media.pause());
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.closest('.h5-screen[inert]')) focused.blur();
  }, [currentIdentity]);

  useEffect(
    () => () => {
      window.dispatchEvent(new CustomEvent(screenDeactivateEvent));
    },
    [],
  );

  const value = useMemo<AppNavigation>(
    () => ({
      screens,
      activeModule: module,
      canGoBack: !!module && !!state.current.previous(module),
      openModule: (target) => {
        const last = state.current.destinationLocation(target);
        const destination = locationHref(last);
        pendingRestore.current = destination;
        navigate(destination, { state: last.state });
      },
      closeModule,
      goBack,
      exitStudy: goBack,
      transitioning: !!transition,
    }),
    [location, transition],
  );
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useAppNavigation() {
  const value = useContext(NavigationContext);
  if (!value) throw new Error('Application navigation is unavailable');
  return value;
}

export { useScreenActive } from '../lib/screen-lifecycle';
