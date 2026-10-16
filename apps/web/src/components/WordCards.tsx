import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, Pin, Star, X } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { api } from '../lib/api';
import type { Word } from '../lib/types';
import { WordCardContext, wordCardPlacement } from '../lib/word-cards';
import { dictionaryText } from '../lib/dictionary';
import { beforeAppBackEvent, screenDeactivateEvent } from '../lib/screen-lifecycle';
import {
  isWordbookSaved,
  mutateWordbook,
  wordbookEntryPath,
  type WordbookEntryResponse,
} from '../lib/wordbook';
import {
  Empty,
  ErrorNotice,
  IconActionHint,
  Loading,
  Notice,
  WordSaveButton,
  WordView,
} from './UI';
import { AudioButton } from './Pronunciation';
import './word-card-layers.css';

interface ResolvedWord {
  word: Word | null;
  queried: string;
  matchedLemma: string | null;
  matchType: 'exact' | 'inflection' | 'not-found';
}
interface CardState {
  queried: string;
  loading: boolean;
  result: ResolvedWord | null;
  error: unknown;
}
type Bounds = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;

// Only the small corridor between the source word and the card keeps a transient card
// alive. Nearby unrelated text must not turn the entire bounding box into a hover trap.
export function withinWordCardBridge(x: number, y: number, source: Bounds, card: Bounds) {
  const left = Math.min(source.left, card.left) - 5;
  const right = Math.max(source.right, card.right) + 5;
  if (x < left || x > right) return false;
  if (card.top >= source.bottom) return y >= source.bottom - 5 && y <= card.top + 5;
  if (card.bottom <= source.top) return y >= card.bottom - 5 && y <= source.top + 5;
  return false;
}

export function WordCardContent({ word }: { word: Word }) {
  return (
    <WordCardContext.Provider value={null}>
      <WordView word={word} interactive={false} />
    </WordCardContext.Provider>
  );
}

export function WordCardSummary({ word }: { word: Word }) {
  const available = (word.senses?.length ? word.senses : word.dictionarySenses) ?? [];
  const meanings = available
    .filter((sense) => dictionaryText(sense.definitionZh) || dictionaryText(sense.definitionEn))
    .slice(0, 2);
  return (
    <WordCardContext.Provider value={null}>
      <div className="word-card-quick-content">
        <AudioButton word={word} />
        {meanings.length ? (
          <div className="word-card-quick-meanings">
            {meanings.map((sense) => (
              <div className="word-card-quick-meaning" key={sense.id}>
                {!!dictionaryText(sense.pos) && (
                  <span className="sense-pos">{dictionaryText(sense.pos)}</span>
                )}
                {!!dictionaryText(sense.definitionZh) && (
                  <p className="word-card-summary-zh" lang="zh-CN">
                    {dictionaryText(sense.definitionZh)}
                  </p>
                )}
                {!!dictionaryText(sense.definitionEn) && (
                  <p className="word-card-summary-en" lang="en">
                    {dictionaryText(sense.definitionEn)}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="word-card-summary-empty">暂未收录释义。</p>
        )}
      </div>
    </WordCardContext.Provider>
  );
}

export function WordCardProvider({ children }: { children: ReactNode }) {
  const { user, scope } = useApp();
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const queryClient = useQueryClient();
  const location = useLocation();
  const [card, setCard] = useState<CardState | null>(null);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<Record<string, number> | undefined>(undefined);
  const [placement, setPlacement] = useState('bottom');
  const [detailOpen, setDetailOpen] = useState(false);
  const detailVisible = useRef(false);
  const detailDialog = useRef<HTMLDialogElement>(null);
  const detailTrigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const hoveredSource = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const requestTimer = useRef<number | undefined>(undefined);
  const open = useRef(false);
  const pinState = useRef(false);
  const insideCard = useRef(false);
  const onSource = useRef(false);
  const focusRequested = useRef(false);
  const activeQuery = useRef<string | null>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [actionNotice, setActionNotice] = useState('');
  const word = card?.result?.word;
  const collection = useRemote<WordbookEntryResponse>(
    'wordbook-entry',
    wordbookEntryPath(word?.id ?? ''),
    !!user && !!word,
  );
  const saved = !!word && isWordbookSaved(collection.data, word.id);
  const consolidated = !!word && collection.data?.consolidatedItem?.wordId === word.id;
  const cancelClose = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  }, []);
  const dismiss = useCallback((restoreFocus = false) => {
    generation.current++;
    controller.current?.abort();
    window.clearTimeout(requestTimer.current);
    window.clearTimeout(closeTimer.current);
    requestTimer.current = undefined;
    closeTimer.current = undefined;
    activeQuery.current = null;
    open.current = false;
    pinState.current = false;
    insideCard.current = false;
    onSource.current = false;
    focusRequested.current = false;
    detailVisible.current = false;
    setDetailOpen(false);
    origin.current?.removeAttribute?.('data-word-card-active');
    setCard(null);
    setPinned(false);
    setActionError(null);
    setActionNotice('');
    busyRef.current = false;
    setBusy(false);
    if (restoreFocus && origin.current?.isConnected) origin.current.focus({ preventScroll: true });
  }, []);
  const scheduleClose = useCallback(() => {
    const keyboardFocus = () =>
      !!panel.current?.contains(document.activeElement) &&
      !!(document.activeElement as HTMLElement | null)?.matches(':focus-visible');
    if (
      pinState.current ||
      insideCard.current ||
      onSource.current ||
      keyboardFocus() ||
      closeTimer.current !== undefined
    )
      return;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = undefined;
      if (!pinState.current && !insideCard.current && !onSource.current && !keyboardFocus())
        dismiss();
    }, 250);
  }, [dismiss]);
  const reposition = useCallback(() => {
    if (!origin.current) {
      setPosition(undefined);
      return;
    }
    const rect = origin.current.getBoundingClientRect();
    const viewport = window.visualViewport;
    const surface = panel.current?.querySelector<HTMLElement>('.word-card-panel');
    const scroller = panel.current?.querySelector<HTMLElement>('.word-card-scroll');
    // A short loading skeleton must not permanently constrain the resolved card.
    // Measure the scroll content, rather than the already clipped panel alone.
    const contentHeight =
      surface && scroller
        ? surface.scrollHeight - scroller.clientHeight + scroller.scrollHeight
        : surface?.scrollHeight;
    const measuredHeight =
      contentHeight && Number.isFinite(contentHeight) ? Math.min(430, contentHeight) : undefined;
    const next = wordCardPlacement(
      rect,
      {
        left: viewport?.offsetLeft ?? 0,
        top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
      },
      measuredHeight,
    );
    setPosition(next.style);
    setPlacement(next.placement);
  }, []);
  const pin = useCallback(() => {
    cancelClose();
    pinState.current = true;
    setPinned(true);
  }, [cancelClose]);
  const togglePin = () => {
    cancelClose();
    pinState.current = !pinState.current;
    setPinned(pinState.current);
    setActionNotice(pinState.current ? '词卡已固定，可继续阅读原文' : '已取消固定词卡');
    if (!pinState.current) scheduleClose();
  };
  const closeDetails = useCallback(() => {
    detailVisible.current = false;
    if (detailDialog.current?.open) detailDialog.current.close();
    setDetailOpen(false);
    if (detailTrigger.current?.isConnected) detailTrigger.current.focus({ preventScroll: true });
  }, []);
  const showDetails = () => {
    pin();
    detailVisible.current = true;
    setDetailOpen(true);
  };
  const openWord = useCallback(
    (text: string, anchor: HTMLElement, mode: 'hover' | 'pinned' = 'pinned') => {
      if (panel.current?.contains(anchor) || detailDialog.current?.contains(anchor)) return;
      if (mode === 'hover' && pinState.current) return;
      cancelClose();
      origin.current?.removeAttribute?.('data-word-card-active');
      origin.current = anchor;
      anchor.setAttribute?.('data-word-card-active', 'true');
      hoveredSource.current = anchor;
      onSource.current = mode === 'hover';
      insideCard.current = false;
      reposition();
      if (mode === 'pinned') {
        pin();
        focusRequested.current = true;
      }
      open.current = true;
      if (activeQuery.current === text) {
        if (focusRequested.current) {
          panel.current
            ?.querySelector<HTMLElement>('.word-card-heading')
            ?.focus({ preventScroll: true });
          focusRequested.current = false;
        }
        return;
      }
      controller.current?.abort();
      window.clearTimeout(requestTimer.current);
      const abort = new AbortController();
      controller.current = abort;
      const requestId = ++generation.current;
      activeQuery.current = text;
      setBusy(false);
      busyRef.current = false;
      setActionError(null);
      setActionNotice('');
      setCard({ queried: text, loading: true, result: null, error: null });
      const load = () => {
        requestTimer.current = undefined;
        if (!open.current || generation.current !== requestId) return;
        void api<ResolvedWord>(`dictionary/resolve?text=${encodeURIComponent(text)}`, {
          signal: abort.signal,
        })
          .then((result) => {
            if (generation.current === requestId && open.current)
              setCard({ queried: text, loading: false, result, error: null });
          })
          .catch((error) => {
            if (generation.current === requestId && open.current) {
              activeQuery.current = null;
              setCard({ queried: text, loading: false, result: null, error });
            }
          });
      };
      // The skeleton opens immediately. Only rapid brush-over network requests are debounced.
      if (mode === 'hover') requestTimer.current = window.setTimeout(load, 120);
      else load();
    },
    [cancelClose, pin, reposition],
  );
  const leaveWord = useCallback(
    (anchor: HTMLElement) => {
      if (hoveredSource.current === anchor) onSource.current = false;
      scheduleClose();
    },
    [scheduleClose],
  );
  useEffect(() => {
    dismiss();
  }, [location.key, scope, dismiss]);
  useEffect(() => {
    const back = (event: Event) => {
      if (event.defaultPrevented || !open.current) return;
      event.preventDefault();
      if (detailVisible.current) closeDetails();
      else dismiss(true);
    };
    const leave = () => dismiss();
    window.addEventListener(beforeAppBackEvent, back, true);
    window.addEventListener(screenDeactivateEvent, leave);
    return () => {
      window.removeEventListener(beforeAppBackEvent, back, true);
      window.removeEventListener(screenDeactivateEvent, leave);
    };
  }, [closeDetails, dismiss]);
  useEffect(() => {
    const dialog = detailDialog.current;
    if (!detailOpen || !dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [detailOpen]);
  useEffect(
    () => () => {
      generation.current++;
      open.current = false;
      controller.current?.abort();
      origin.current?.removeAttribute?.('data-word-card-active');
      window.clearTimeout(closeTimer.current);
      window.clearTimeout(requestTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!card) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Node) ||
        panel.current?.contains(target) ||
        detailDialog.current?.contains(target) ||
        origin.current?.contains(target)
      )
        return;
      if (target instanceof Element && target.closest('.word-token')) return;
      if (detailVisible.current) return;
      dismiss();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !detailVisible.current) {
        event.preventDefault();
        dismiss(pinState.current || !!panel.current?.contains(document.activeElement));
      }
    };
    const move = (event: PointerEvent) => {
      if (
        pinState.current ||
        event.pointerType !== 'mouse' ||
        insideCard.current ||
        onSource.current
      )
        return;
      const source = origin.current?.getBoundingClientRect();
      const bounds = panel.current?.getBoundingClientRect();
      if (source && bounds && withinWordCardBridge(event.clientX, event.clientY, source, bounds))
        cancelClose();
      else scheduleClose();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keyboard);
    document.addEventListener('pointermove', move);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    window.visualViewport?.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('scroll', reposition);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reposition);
    if (panel.current) observer?.observe(panel.current);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keyboard);
      document.removeEventListener('pointermove', move);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      window.visualViewport?.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('scroll', reposition);
      observer?.disconnect();
    };
  }, [card !== null, cancelClose, dismiss, reposition, scheduleClose]);
  useEffect(() => {
    if (!card) return;
    if (focusRequested.current) {
      panel.current
        ?.querySelector<HTMLElement>('.word-card-heading')
        ?.focus({ preventScroll: true });
      focusRequested.current = false;
    }
    const content = panel.current?.querySelector('.word-card-scroll');
    if (content) content.scrollTop = 0;
    reposition();
  }, [card, reposition]);
  async function toggleSaved() {
    if (!user || !word || busyRef.current) return;
    const target = word;
    const requestId = generation.current;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    setActionNotice('');
    try {
      const receipt = await mutateWordbook(
        queryClient,
        scope,
        target.id,
        saved,
        () => currentScope.current === scope,
      );
      if (receipt && generation.current === requestId && currentScope.current === scope)
        setActionNotice(
          saved ? (consolidated ? '已移除已巩固收藏' : '已从生词本移除') : '已加入生词本',
        );
    } catch (error) {
      if (generation.current === requestId && currentScope.current === scope) setActionError(error);
    } finally {
      if (generation.current === requestId && currentScope.current === scope) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  const context = useMemo(() => ({ openWord, leaveWord }), [openWord, leaveWord]);
  return (
    <WordCardContext.Provider value={context}>
      {children}
      {card &&
        createPortal(
          <>
            <div
              ref={panel}
              className="word-card-layer"
              style={position}
              role="dialog"
              aria-modal="false"
              aria-labelledby={titleId}
              data-mode={pinned ? 'pinned' : 'hover'}
              data-placement={placement}
              onPointerEnter={() => {
                insideCard.current = true;
                cancelClose();
              }}
              onPointerLeave={() => {
                insideCard.current = false;
                scheduleClose();
              }}
              onPointerDown={(event) => {
                if (!(event.target as HTMLElement).closest?.('[data-word-card-pin]')) pin();
              }}
              onFocusCapture={(event) => {
                if (!(event.target as HTMLElement).closest?.('[data-word-card-pin]')) pin();
              }}
            >
              <div className="word-card-panel">
                <div className="word-card-top">
                  <div className="word-card-heading" tabIndex={-1}>
                    <h2 id={titleId}>{word?.lemma || card.queried}</h2>
                  </div>
                  <div className="word-card-tools">
                    {word &&
                      (user ? (
                        <WordSaveButton
                          lemma={word.lemma}
                          saved={saved}
                          consolidated={consolidated}
                          busy={busy}
                          disabled={collection.isFetching || !!collection.error || !collection.data}
                          onClick={() => void toggleSaved()}
                        />
                      ) : (
                        <IconActionHint label="登录后加入生词本">
                          <Link
                            className="icon-button word-save-button"
                            to="/auth"
                            aria-label={`登录后加入生词本 ${word.lemma}`}
                          >
                            <Star size={20} />
                          </Link>
                        </IconActionHint>
                      ))}
                    <IconActionHint label={pinned ? '取消固定卡片' : '固定卡片'}>
                      <button
                        type="button"
                        className={`icon-button word-card-pin${pinned ? ' pinned' : ''}`}
                        data-word-card-pin
                        aria-label={pinned ? '取消固定词卡' : '固定词卡'}
                        aria-pressed={pinned}
                        onClick={togglePin}
                      >
                        <Pin size={17} fill={pinned ? 'currentColor' : 'none'} />
                      </button>
                    </IconActionHint>
                    <button
                      className="icon-button"
                      aria-label="关闭词卡，返回原文"
                      onClick={() => dismiss(true)}
                    >
                      <X size={19} />
                    </button>
                  </div>
                </div>
                {actionNotice && (
                  <div className="word-card-save-notice" role="status">
                    <span>{actionNotice}</span>
                    {!actionNotice.includes('固定') && <Link to="/wordbook">查看生词本</Link>}
                  </div>
                )}
                {word && !!(actionError ?? collection.error) && (
                  <div className="word-card-action-notice">
                    <ErrorNotice
                      error={actionError ?? collection.error}
                      onRetry={collection.error ? () => void collection.refetch() : undefined}
                    />
                  </div>
                )}
                <div className="word-card-scroll">
                  {card.loading && <Loading text="正在查找…" />}
                  <ErrorNotice error={card.error} />
                  {!!card.error && (
                    <button
                      className="button ghost"
                      onClick={() =>
                        origin.current && openWord(card.queried, origin.current, 'pinned')
                      }
                    >
                      重新查询
                    </button>
                  )}
                  {card.result && !card.result.word && (
                    <Empty
                      title="没有找到这个词。"
                      description="换个拼写试试。"
                      action={
                        <Link
                          className="button ghost"
                          to={`/lookup?q=${encodeURIComponent(card.queried)}`}
                        >
                          到查词页搜索
                        </Link>
                      }
                    />
                  )}
                  {word && (
                    <>
                      {card.result?.matchType === 'inflection' && (
                        <Notice>
                          {card.queried} → {card.result.matchedLemma}
                        </Notice>
                      )}
                      <WordCardSummary word={word} />
                    </>
                  )}
                </div>
                {word && (
                  <button
                    ref={detailTrigger}
                    className="word-card-detail-trigger"
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded={detailOpen}
                    onClick={showDetails}
                  >
                    查看详细释义 <ArrowUpRight size={17} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
            {word && detailOpen && (
              <WordCardContext.Provider value={null}>
                <dialog
                  ref={detailDialog}
                  className="word-card-detail-dialog"
                  aria-labelledby={`${titleId}-detail`}
                  onCancel={(event) => {
                    event.preventDefault();
                    closeDetails();
                  }}
                  onClick={(event) => {
                    if (event.target === event.currentTarget) closeDetails();
                  }}
                >
                  <div className="word-card-detail-panel">
                    <div className="word-card-detail-top">
                      <button
                        className="icon-button"
                        type="button"
                        aria-label="返回简明词卡"
                        onClick={closeDetails}
                      >
                        <ArrowLeft size={20} />
                      </button>
                      <h2 id={`${titleId}-detail`}>{word.lemma}</h2>
                      {user && (
                        <WordSaveButton
                          lemma={word.lemma}
                          saved={saved}
                          consolidated={consolidated}
                          busy={busy}
                          disabled={collection.isFetching || !!collection.error || !collection.data}
                          onClick={() => void toggleSaved()}
                        />
                      )}
                      <button
                        className="icon-button"
                        type="button"
                        aria-label="关闭详细释义，返回简明词卡"
                        onClick={closeDetails}
                      >
                        <X size={20} />
                      </button>
                    </div>
                    {actionNotice && (
                      <p className="word-card-detail-feedback" role="status">
                        {actionNotice}
                      </p>
                    )}
                    {!!(actionError ?? collection.error) && (
                      <div className="word-card-action-notice">
                        <ErrorNotice
                          error={actionError ?? collection.error}
                          onRetry={collection.error ? () => void collection.refetch() : undefined}
                        />
                      </div>
                    )}
                    <div className="word-card-detail-scroll">
                      <WordCardContent word={word} />
                    </div>
                  </div>
                </dialog>
              </WordCardContext.Provider>
            )}
          </>,
          document.body,
        )}
    </WordCardContext.Provider>
  );
}
