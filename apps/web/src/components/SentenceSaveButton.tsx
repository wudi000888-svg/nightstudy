import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check, LoaderCircle, Quote } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { api, errorText, post } from '../lib/api';
import type { SavedSentence } from '../lib/mobile-content-types';

interface SentenceStatus {
  wordId: string;
  items: {
    sourceType: 'word-example';
    sourceId: string;
    saved: boolean;
    sentenceId: string | null;
  }[];
}
export interface SentenceSaveButtonProps {
  wordId: string;
  sourceType: 'word-example';
  sourceId: string;
  compact?: boolean;
}
export function SentenceSaveButton({
  wordId,
  sourceType,
  sourceId,
  compact = false,
}: SentenceSaveButtonProps) {
  const { user, scope } = useApp(),
    client = useQueryClient();
  const path = `sentences/status?wordId=${encodeURIComponent(wordId)}`;
  const status = useRemote<SentenceStatus>('sentences', path, !!user);
  const entry =
    status.data?.wordId === wordId
      ? status.data.items.find(
          (item) => item.sourceType === sourceType && item.sourceId === sourceId,
        )
      : undefined;
  const saved = entry?.saved === true;
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState<unknown>(null);
  const identity = `${scope}:${wordId}:${sourceType}:${sourceId}`,
    current = useRef(identity),
    lifetime = useRef(0),
    lock = useRef(false);
  current.current = identity;
  useEffect(() => {
    lifetime.current++;
    lock.current = false;
    setBusy(false);
    setMessage('');
    setError(null);
    return () => {
      lifetime.current++;
    };
  }, [identity]);
  async function toggle() {
    if (lock.current || !user || !entry) return;
    const owner = identity,
      life = lifetime.current;
    const active = () => current.current === owner && lifetime.current === life;
    lock.current = true;
    setBusy(true);
    setError(null);
    setMessage('');
    const key = [scope, 'sentences', path];
    try {
      await client.cancelQueries({ queryKey: key, exact: true });
      if (!active()) return;
      let sentenceId: string | null = null;
      if (saved) {
        if (!entry.sentenceId) throw new Error('收藏状态已变化，请重新读取。');
        await api(`sentences/${encodeURIComponent(entry.sentenceId)}`, { method: 'DELETE' });
      } else {
        const result = await post<{ sentence: SavedSentence }>('sentences', {
          wordId,
          sourceType,
          sourceId,
        });
        if (
          result.sentence.sourceType !== sourceType ||
          result.sentence.sourceId !== sourceId ||
          result.sentence.wordId !== wordId
        )
          throw new Error('例句已变化，请重新打开词条。');
        sentenceId = result.sentence.id;
      }
      if (!active()) return;
      client.setQueryData<SentenceStatus>(key, (old) =>
        old?.wordId === wordId
          ? {
              ...old,
              items: old.items.map((item) =>
                item.sourceType === sourceType && item.sourceId === sourceId
                  ? { ...item, saved: !saved, sentenceId }
                  : item,
              ),
            }
          : old,
      );
      setMessage(saved ? '已移出句库。' : '已加入句库。');
      await client.invalidateQueries({ queryKey: [scope, 'sentences'] });
    } catch (value) {
      if (active()) setError(value);
    } finally {
      if (active()) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  const label = busy ? '正在保存…' : saved ? '已收藏' : '收藏这句';
  return (
    <span
      className="sentence-save-control"
      style={{
        display: 'inline-flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        marginTop: 6,
      }}
    >
      {!user ? (
        <Link className="text-link" to="/auth">
          <Quote size={14} />
          登录收藏
        </Link>
      ) : (
        <button
          type="button"
          className={`button ghost sentence-save-button${saved ? ' saved' : ''}`}
          style={{ minHeight: 44, minWidth: compact ? 94 : 112, fontSize: '.8125rem' }}
          aria-label={saved ? '移出句库' : '收藏这句'}
          aria-pressed={saved}
          disabled={busy || status.isPending || (!status.error && !entry)}
          onClick={() => (status.error ? void status.refetch() : void toggle())}
        >
          {busy || status.isPending ? (
            <LoaderCircle size={14} className="spin" />
          ) : saved ? (
            <Check size={14} />
          ) : (
            <Quote size={14} />
          )}{' '}
          {status.error ? '重试读取收藏' : !entry && !status.isPending ? '暂不可收藏' : label}
        </button>
      )}
      {message && (
        <small role="status">
          {message} {<Link to="/sentences">查看句库</Link>}
        </small>
      )}
      {!!error && <small role="alert">{errorText(error)}</small>}
    </span>
  );
}
