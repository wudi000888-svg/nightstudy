import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Pin, Star, X } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { api, post } from '../lib/api';
import { dictionaryText } from '../lib/dictionary';
import type { Word, WordbookItem } from '../lib/types';
import { WordCardContext } from '../lib/word-cards';
import { Empty, ErrorNotice, Loading, Notice, WordSaveButton, WordView } from './UI';

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

export function WordCardSummaryText({ word }: { word: Word }) {
  const sense = word.senses?.find((value) => !!dictionaryText(value.definitionZh));
  const summarize = (value: string | undefined) => {
    const text = dictionaryText(value).replace(/\s+/g, ' ').trim();
    const characters = Array.from(text);
    return characters.length > 160 ? `${characters.slice(0, 160).join('')}…` : text;
  };
  const chinese = summarize(sense?.definitionZh);
  const english = summarize(sense?.definitionEn);
  if (!chinese) return null;
  return (
    <div className="word-card-summary-text">
      {sense?.pos && <span className="word-card-pos">{sense.pos}</span>}
      <div className="word-card-summary-language">
        <p className="word-card-summary-zh" lang="zh-CN">
          {chinese}
        </p>
      </div>
      {english && (
        <div className="word-card-summary-language">
          <p className="word-card-summary-en" lang="en">
            {english}
          </p>
        </div>
      )}
    </div>
  );
}

export function WordCardProvider({ children }: { children: ReactNode }) {
  const { user, scope } = useApp();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [card, setCard] = useState<CardState | null>(null);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<Record<string, number> | undefined>(undefined);
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
  const [actionError, setActionError] = useState<unknown>(null);
  const word = card?.result?.word;
  const collection = useRemote<{
    item: Pick<WordbookItem, 'id' | 'wordId' | 'note' | 'favorite' | 'paused'> | null;
  }>('wordbook-entry', `wordbook/${encodeURIComponent(word?.id ?? '')}`, !!user && !!word);
  const saved = !!word && collection.data?.item?.wordId === word.id;
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
    setCard(null);
    setPinned(false);
    setActionError(null);
    setBusy(false);
    if (restoreFocus && origin.current?.isConnected) origin.current.focus({ preventScroll: true });
  }, []);
  const scheduleClose = useCallback(() => {
    if (
      pinState.current ||
      insideCard.current ||
      onSource.current ||
      closeTimer.current !== undefined
    )
      return;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = undefined;
      if (!pinState.current && !insideCard.current && !onSource.current) dismiss();
    }, 250);
  }, [dismiss]);
  const reposition = useCallback(() => {
    if (!origin.current || window.innerWidth <= 660) {
      setPosition(undefined);
      return;
    }
    const rect = origin.current.getBoundingClientRect();
    const width = Math.min(470, window.innerWidth - 32);
    const below = window.innerHeight - rect.bottom;
    const useBelow = below >= Math.min(320, rect.top);
    const maxHeight = Math.min(
      Math.max(120, window.innerHeight - 32),
      Math.max(160, Math.min(640, (useBelow ? below : rect.top) - 24)),
    );
    const candidateTop = useBelow ? rect.bottom + 8 : rect.top - maxHeight - 8;
    setPosition({
      left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)),
      top: Math.max(16, Math.min(candidateTop, window.innerHeight - maxHeight - 16)),
      width,
      maxHeight,
    });
  }, []);
  const pin = useCallback(() => {
    cancelClose();
    pinState.current = true;
    setPinned(true);
  }, [cancelClose]);
  const openWord = useCallback(
    (text: string, anchor: HTMLElement, mode: 'hover' | 'pinned' = 'pinned') => {
      if (panel.current?.contains(anchor)) return;
      if (mode === 'hover' && pinState.current) return;
      cancelClose();
      origin.current = anchor;
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
      setActionError(null);
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
  useEffect(
    () => () => {
      generation.current++;
      open.current = false;
      controller.current?.abort();
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
        origin.current?.contains(target)
      )
        return;
      if (target instanceof Element && target.closest('.word-token')) return;
      dismiss();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
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
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keyboard);
      document.removeEventListener('pointermove', move);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
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
  }, [card]);
  async function toggleSaved() {
    if (!user || !word || busy) return;
    const target = word;
    const requestId = generation.current;
    setBusy(true);
    setActionError(null);
    try {
      if (saved) await post(`wordbook/${encodeURIComponent(target.id)}`, {}, 'DELETE');
      else await post('wordbook', { wordId: target.id });
      await collection.refetch();
      await queryClient.invalidateQueries({ queryKey: [scope, 'wordbook'] });
    } catch (error) {
      if (generation.current === requestId) setActionError(error);
    } finally {
      if (generation.current === requestId) setBusy(false);
    }
  }
  const context = useMemo(() => ({ openWord, leaveWord }), [openWord, leaveWord]);
  return (
    <WordCardContext.Provider value={context}>
      {children}
      {card &&
        createPortal(
          <div
            ref={panel}
            className="word-card-layer"
            style={position}
            role="dialog"
            aria-modal="false"
            aria-labelledby={titleId}
            data-mode={pinned ? 'pinned' : 'hover'}
            onPointerEnter={() => {
              insideCard.current = true;
              cancelClose();
            }}
            onPointerLeave={() => {
              insideCard.current = false;
              scheduleClose();
            }}
            onPointerDown={pin}
            onFocusCapture={pin}
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
                        busy={busy}
                        disabled={collection.isFetching || !!collection.error || !collection.data}
                        onClick={() => void toggleSaved()}
                      />
                    ) : (
                      <Link
                        className="icon-button word-save-button"
                        to="/auth"
                        aria-label={`登录后收藏 ${word.lemma}`}
                      >
                        <Star size={20} />
                      </Link>
                    ))}
                  {!pinned && (
                    <button className="icon-button" aria-label="固定词卡" onClick={pin}>
                      <Pin size={17} />
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label="关闭词卡，返回原文"
                    onClick={() => dismiss(true)}
                  >
                    <X size={19} />
                  </button>
                </div>
              </div>
              {word && (
                <div className="word-card-summary">
                  <WordCardSummaryText word={word} />
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
                    <ErrorNotice
                      error={actionError ?? collection.error}
                      onRetry={collection.error ? () => void collection.refetch() : undefined}
                    />
                    {card.result?.matchType === 'inflection' && (
                      <Notice>
                        {card.queried} → {card.result.matchedLemma}
                      </Notice>
                    )}
                    <WordCardContent word={word} />
                  </>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </WordCardContext.Provider>
  );
}
