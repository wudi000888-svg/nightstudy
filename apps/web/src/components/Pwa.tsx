import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import { Download, RefreshCw, Check } from 'lucide-react';
import { useApp } from '../AppContext';
import { mountUrl } from '../lib/api';
import { activeWriteRequests, subscribeRequestActivity } from '../lib/request-activity';
import './pwa.css';

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
interface PwaState {
  installed: boolean;
  canInstall: boolean;
  updateReady: boolean;
  canUpdate: boolean;
  install: () => Promise<void>;
  update: () => void;
}
const PwaContext = createContext<PwaState | null>(null);
export function PwaProvider({ children }: { children: ReactNode }) {
  const { site, pending, scope } = useApp();
  const { pathname } = useLocation();
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);
  const [waiting, setWaiting] = useState<ServiceWorkerRegistration | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [reloadReady, setReloadReady] = useState(false);
  const writes = useSyncExternalStore(subscribeRequestActivity, activeWriteRequests, () => 0);
  const acceptedUpdate = useRef<string | null>(null);
  const context = useRef({ pathname, pending, scope });
  context.current = { pathname, pending, scope };
  const safeNow = () =>
    context.current.pathname === '/' &&
    context.current.pending === 0 &&
    activeWriteRequests() === 0 &&
    document.visibilityState === 'visible';
  const safeToOffer = pathname === '/' && pending === 0 && writes === 0;
  useEffect(() => {
    const media = window.matchMedia('(display-mode: standalone)');
    const change = () =>
      setInstalled(
        media.matches || !!(navigator as Navigator & { standalone?: boolean }).standalone,
      );
    const offer = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    const installed = () => {
      setInstalled(true);
      setPrompt(null);
    };
    change();
    media.addEventListener('change', change);
    window.addEventListener('beforeinstallprompt', offer);
    window.addEventListener('appinstalled', installed);
    return () => {
      media.removeEventListener('change', change);
      window.removeEventListener('beforeinstallprompt', offer);
      window.removeEventListener('appinstalled', installed);
    };
  }, []);
  useEffect(() => {
    if (!import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) return;
    setWaiting(null);
    setDismissed(false);
    setReloadReady(false);
    let alive = true;
    let installedWorker: ServiceWorker | null = null;
    let registration: ServiceWorkerRegistration | null = null;
    const ready = () => {
      if (alive && registration?.waiting && navigator.serviceWorker.controller) {
        setWaiting(registration);
        setDismissed(false);
      }
    };
    const found = () => {
      installedWorker?.removeEventListener('statechange', ready);
      installedWorker = registration?.installing ?? null;
      installedWorker?.addEventListener('statechange', ready);
    };
    const changed = () => {
      setWaiting(null);
      const acceptedScope = acceptedUpdate.current;
      acceptedUpdate.current = null;
      if (acceptedScope === null || acceptedScope !== context.current.scope) return;
      // An update must never reload a newly started answer or an unsynced action.
      if (safeNow()) window.location.reload();
      else setReloadReady(true);
    };
    navigator.serviceWorker.addEventListener('controllerchange', changed);
    void navigator.serviceWorker
      .register(mountUrl('/sw.js'), {
        scope: mountUrl('/'),
        updateViaCache: 'none',
      })
      .then((value) => {
        if (!alive) return;
        registration = value;
        ready();
        value.addEventListener('updatefound', found);
        found();
      })
      .catch(() => {
        /* Browser installation is an enhancement; learning remains online. */
      });
    return () => {
      alive = false;
      acceptedUpdate.current = null;
      installedWorker?.removeEventListener('statechange', ready);
      registration?.removeEventListener('updatefound', found);
      navigator.serviceWorker.removeEventListener('controllerchange', changed);
    };
  }, [site.siteId, site.instanceId, site.basePath, scope]);
  async function install() {
    if (!prompt) return;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      // Browsers can withdraw the one-shot prompt; the menu entry remains available.
    } finally {
      setPrompt(null);
    }
  }
  function update() {
    // Recheck the store synchronously: another screen can start saving before React renders.
    if (!safeNow()) return;
    if (reloadReady) {
      window.location.reload();
      return;
    }
    if (!waiting?.waiting) return;
    acceptedUpdate.current = scope;
    waiting.waiting.postMessage({ type: 'ACTIVATE' });
  }
  return (
    <PwaContext.Provider
      value={{
        installed,
        canInstall: !!prompt,
        updateReady: !!waiting?.waiting || reloadReady,
        canUpdate: safeToOffer,
        install,
        update,
      }}
    >
      {children}
      {(waiting?.waiting || reloadReady) && !dismissed && safeToOffer && (
        <aside className="pwa-update-notice" role="status">
          <span>有新版可用</span>
          <button type="button" onClick={update}>
            更新后继续
          </button>
          <button type="button" onClick={() => setDismissed(true)} aria-label="稍后更新">
            稍后
          </button>
        </aside>
      )}
    </PwaContext.Provider>
  );
}

export function PwaSettings() {
  const pwa = useContext(PwaContext);
  if (!pwa) return null;
  return (
    <section className="pwa-settings" aria-label="应用安装与更新">
      <h3>随时回来学习</h3>
      {pwa.installed ? (
        <p>
          <Check size={17} aria-hidden="true" />
          已添加到主屏幕
        </p>
      ) : pwa.canInstall ? (
        <button type="button" className="button ghost" onClick={() => void pwa.install()}>
          <Download size={17} />
          添加到主屏幕
        </button>
      ) : (
        <p>在浏览器的分享或菜单中选择“添加到主屏幕”，下次直接打开。</p>
      )}
      {pwa.updateReady &&
        (pwa.canUpdate ? (
          <button type="button" className="button ghost" onClick={pwa.update}>
            <RefreshCw size={17} />
            更新应用
          </button>
        ) : (
          <p>有新版可用，回首页后更新。</p>
        ))}
    </section>
  );
}
