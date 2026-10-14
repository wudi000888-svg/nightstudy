import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from './lib/api';
import type { Me, Site, User } from './lib/types';
import {
  flushCommands,
  pendingCommands,
  conflictingCommands,
  discardConflictedCommand,
  type CommandConflict,
} from './lib/outbox';

interface AppState {
  site: Site;
  user: User | null;
  scope: string;
  refresh: () => Promise<void>;
  pending: number;
  sync: () => Promise<void>;
  syncNote: string;
  conflicts: CommandConflict[];
  discardConflict: (id: string) => Promise<void>;
}
const Context = createContext<AppState | null>(null);
export function useApp() {
  const value = useContext(Context);
  if (!value) throw new Error('Application context is unavailable');
  return value;
}
export function useRemote<T>(key: string, path: string, enabled = true) {
  const { scope } = useApp();
  return useQuery<T, Error>({
    queryKey: [scope, key, path],
    queryFn: () => api<T>(path),
    enabled,
    retry: false,
  });
}
export function AppProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const siteQuery = useQuery({
    queryKey: ['bootstrap-site'],
    queryFn: () => api<Site>('site'),
    retry: false,
  });
  const meQuery = useQuery({
    queryKey: ['bootstrap-me'],
    queryFn: () => api<Me>('me'),
    enabled: !!siteQuery.data,
    retry: false,
  });
  const [pending, setPending] = useState(0);
  const [syncNote, setSyncNote] = useState('');
  const [conflicts, setConflicts] = useState<CommandConflict[]>([]);
  const scope = `${siteQuery.data?.siteId ?? ''}:${meQuery.data?.user?.id ?? 'guest'}`;
  const [syncScope, setSyncScope] = useState(scope);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  async function refresh() {
    queryClient.removeQueries({
      predicate: (query) => !String(query.queryKey[0]).startsWith('bootstrap'),
    });
    await Promise.all([siteQuery.refetch(), meQuery.refetch()]);
  }
  async function sync(silent = false) {
    if (!meQuery.data?.user) return;
    try {
      const result = await flushCommands(scope, () => currentScope.current === scope);
      const blocked = await conflictingCommands(scope);
      if (currentScope.current !== scope) return;
      setPending(result.pending);
      setConflicts(blocked);
      if (!silent || result.applied || result.pending || result.conflicts)
        setSyncNote(
          result.conflicts
            ? '有同步冲突，请在今日任务中读取服务器进度并逐条处理。'
            : result.pending
              ? '仍有暂存操作，稍后可再次重试。'
              : result.applied
                ? '暂存操作已同步。'
                : '记录已同步。',
        );
      if (result.applied) {
        await queryClient.invalidateQueries({ queryKey: [scope] });
        if (currentScope.current !== scope) return;
        window.dispatchEvent(new Event('nightstudy-synced'));
      }
    } catch (error) {
      if (currentScope.current === scope) setSyncNote(errorText(error));
    }
  }
  async function discardConflict(id: string) {
    const owner = scope;
    if (!meQuery.data?.user || currentScope.current !== owner) return;
    await discardConflictedCommand(owner, id);
    const [rows, blocked] = await Promise.all([pendingCommands(owner), conflictingCommands(owner)]);
    if (currentScope.current !== owner) return;
    setPending(rows.length);
    setConflicts(blocked);
    setSyncNote(
      rows.length
        ? '已放弃这一条冲突操作，其余暂存记录仍保留，可重试同步。'
        : '已放弃这一条冲突操作，服务器已接受的记录保留。',
    );
    await queryClient.invalidateQueries({ queryKey: [owner] });
  }
  useEffect(() => {
    let active = true;
    setSyncScope(scope);
    setPending(0);
    setConflicts([]);
    setSyncNote('');
    const update = () => {
      if (!meQuery.data?.user) {
        setPending(0);
        return;
      }
      Promise.all([pendingCommands(scope), conflictingCommands(scope)])
        .then(([rows, blocked]) => {
          if (active && currentScope.current === scope) {
            setPending(rows.length);
            setConflicts(blocked);
          }
        })
        .catch(() => {});
    };
    update();
    const timer = window.setInterval(update, 4000);
    const online = () => {
      void sync(true);
    };
    const expired = () => {
      void meQuery.refetch();
    };
    window.addEventListener('online', online);
    window.addEventListener('nightstudy-session-expired', expired);
    if (meQuery.data?.user && navigator.onLine) void sync(true);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('online', online);
      window.removeEventListener('nightstudy-session-expired', expired);
    };
  }, [scope]);
  if (siteQuery.isPending || (siteQuery.data && meQuery.isPending))
    return (
      <div className="boot-screen">
        <span className="boot-moon">☾</span>
        <p>正在点亮自习室…</p>
      </div>
    );
  if (siteQuery.error || meQuery.error || !siteQuery.data || !meQuery.data)
    return (
      <div className="boot-screen">
        <span className="boot-moon">☾</span>
        <h1>自习室暂时没有连接。</h1>
        <p>{errorText(siteQuery.error ?? meQuery.error)}</p>
        <button
          className="button primary"
          onClick={() => {
            void siteQuery.refetch();
            void meQuery.refetch();
          }}
        >
          重新连接
        </button>
      </div>
    );
  return (
    <Context.Provider
      value={{
        site: siteQuery.data,
        user: meQuery.data.user,
        scope,
        refresh,
        pending: syncScope === scope ? pending : 0,
        sync,
        syncNote: syncScope === scope ? syncNote : '',
        conflicts: syncScope === scope ? conflicts : [],
        discardConflict,
      }}
    >
      {children}
    </Context.Provider>
  );
}
