import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Bookmark, Check, X } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { api, post } from '../lib/api';
import { dictionaryText } from '../lib/dictionary';
import type { Word, WordbookItem } from '../lib/types';
import { WordCardContext } from '../lib/word-cards';
import { Empty, ErrorNotice, Loading, Notice, WordView } from './UI';

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

export function WordCardProvider({ children }: { children: ReactNode }) {
  const { user, scope } = useApp();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [card, setCard] = useState<CardState | null>(null);
  const [position, setPosition] = useState<Record<string, number> | undefined>(undefined);
  const dialog = useRef<HTMLDialogElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const open = useRef(false);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const word = card?.result?.word;
  const summary = useMemo(() => {
    const definition = word?.senses
      ?.map((sense) => dictionaryText(sense.definitionZh).replace(/\s+/g, ' ').trim())
      .find(Boolean);
    if (!definition) return '';
    const characters = Array.from(definition);
    return characters.length > 160 ? `${characters.slice(0, 160).join('')}…` : definition;
  }, [word]);
  const collection = useRemote<{
    item: Pick<WordbookItem, 'id' | 'wordId' | 'note' | 'favorite' | 'paused'> | null;
  }>('wordbook-entry', `wordbook/${encodeURIComponent(word?.id ?? '')}`, !!user && !!word);
  const saved = !!word && collection.data?.item?.wordId === word.id;
  const dismiss = useCallback(() => {
    generation.current++;
    controller.current?.abort();
    open.current = false;
    setCard(null);
    setNotice('');
    setActionError(null);
  }, []);
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
      Math.max(48, window.innerHeight - 32),
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
  const openWord = useCallback(
    (text: string, anchor: HTMLElement) => {
      if (!open.current) {
        origin.current = anchor;
        reposition();
      }
      open.current = true;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const requestId = ++generation.current;
      setActionError(null);
      setNotice('');
      setCard({ queried: text, loading: true, result: null, error: null });
      void api<ResolvedWord>(`dictionary/resolve?text=${encodeURIComponent(text)}`, {
        signal: abort.signal,
      })
        .then((result) => {
          if (generation.current === requestId && open.current)
            setCard({ queried: text, loading: false, result, error: null });
        })
        .catch((error) => {
          if (generation.current === requestId && open.current)
            setCard({ queried: text, loading: false, result: null, error });
        });
    },
    [reposition],
  );
  useEffect(() => {
    dismiss();
  }, [location.key, scope, dismiss]);
  useEffect(() => {
    if (!card) return;
    const element = dialog.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (element && !element.open) element.showModal();
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('resize', reposition);
      element?.close();
      document.body.style.overflow = previousOverflow;
      if (origin.current?.isConnected) origin.current.focus({ preventScroll: true });
    };
  }, [card !== null, reposition]);
  useEffect(() => {
    if (!card) return;
    dialog.current
      ?.querySelector<HTMLElement>('.word-card-heading')
      ?.focus({ preventScroll: true });
    const content = dialog.current?.querySelector('.word-card-scroll');
    if (content) content.scrollTop = 0;
  }, [card?.queried, card?.loading]);
  async function toggleSaved() {
    if (!user || !word) return;
    const target = word;
    const requestId = generation.current;
    setBusy(true);
    setActionError(null);
    try {
      if (saved) await post(`wordbook/${encodeURIComponent(target.id)}`, {}, 'DELETE');
      else await post('wordbook', { wordId: target.id });
      await collection.refetch();
      await queryClient.invalidateQueries({ queryKey: [scope, 'wordbook'] });
      if (generation.current === requestId)
        setNotice(saved ? '已从本站生词本移除。' : '已加入本站生词本。');
    } catch (error) {
      if (generation.current === requestId) setActionError(error);
    } finally {
      setBusy(false);
    }
  }
  const context = useMemo(() => ({ openWord }), [openWord]);
  return (
    <WordCardContext.Provider value={context}>
      {children}
      <dialog
        ref={dialog}
        className="word-card-modal"
        style={position}
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault();
          dismiss();
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            dismiss();
        }}
      >
        {card && (
          <>
            <div className="word-card-top">
              <div className="word-card-heading" tabIndex={-1}>
                <span className="tiny-label">点词查询 · 一张词卡</span>
                <h2 id={titleId}>{card.queried}</h2>
              </div>
              <button className="icon-button" aria-label="关闭词卡，返回原文" onClick={dismiss}>
                <X size={19} />
              </button>
            </div>
            {word && (
              <div className="word-card-summary">
                <p>{summary || '该词条来源暂未提供中文释义。'}</p>
                <div className="word-card-bookmark">
                  {user ? (
                    <button
                      className="button ghost"
                      disabled={
                        busy || collection.isFetching || !!collection.error || !collection.data
                      }
                      onClick={() => void toggleSaved()}
                    >
                      {saved ? <Check size={16} /> : <Bookmark size={16} />}
                      {busy ? '正在保存…' : saved ? '已在生词本 · 移除' : '加入本站生词本'}
                    </button>
                  ) : (
                    <Link className="button ghost" to="/auth">
                      <Bookmark size={16} />
                      登录后加入生词本
                    </Link>
                  )}
                </div>
              </div>
            )}
            <div className="word-card-scroll">
              {card.loading && <Loading text="正在精确查找这个词形…" />}
              <ErrorNotice error={card.error} />
              {!!card.error && (
                <button
                  className="button ghost"
                  onClick={() => origin.current && openWord(card.queried, origin.current)}
                >
                  重新查询
                </button>
              )}
              {card.result && !card.result.word && (
                <Empty
                  title="词典未收录这个词形。"
                  description="这里仅显示精确匹配或词典已确认的原形，不会用相近的前缀词替代。"
                  action={
                    <Link
                      className="button ghost"
                      to={`/lookup?q=${encodeURIComponent(card.queried)}`}
                    >
                      到查词页手动搜索
                    </Link>
                  }
                />
              )}
              {word && (
                <>
                  <ErrorNotice error={actionError ?? collection.error} />
                  {notice && <Notice>{notice}</Notice>}
                  {card.result?.matchType === 'inflection' && (
                    <Notice>
                      词形 {card.queried} · 词典确认的原形 {card.result.matchedLemma}
                    </Notice>
                  )}
                  <WordView word={word} />
                  <p className="fine-print word-card-help">
                    继续点击英文释义或例句中的词，会替换这张卡片。按 Esc 或点击外侧可回到原文。
                  </p>
                </>
              )}
            </div>
          </>
        )}
      </dialog>
    </WordCardContext.Provider>
  );
}
