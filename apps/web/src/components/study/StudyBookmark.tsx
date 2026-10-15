import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useApp, useRemote } from '../../AppContext';
import type { Word } from '../../lib/types';
import {
  isWordbookSaved,
  mutateWordbook,
  wordbookEntryPath,
  type WordbookEntryResponse,
} from '../../lib/wordbook';
import { ErrorNotice, WordSaveButton } from '../UI';

export function StudyBookmark({ word }: { word: Word }) {
  const { user, scope } = useApp();
  const client = useQueryClient();
  const entry = useRemote<WordbookEntryResponse>(
    'wordbook-entry',
    wordbookEntryPath(word.id),
    !!user,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const running = useRef(false);
  const active = useRef(true);
  const identity = useRef(`${scope}:${word.id}`);
  identity.current = `${scope}:${word.id}`;
  const saved = isWordbookSaved(entry.data, word.id);
  const consolidated = entry.data?.consolidatedItem?.wordId === word.id;
  useEffect(() => {
    setError(null);
    setNotice('');
  }, [scope, word.id]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function toggle() {
    if (!user || running.current || !entry.data || entry.error || entry.isFetching) return;
    const expected = `${scope}:${word.id}`;
    running.current = true;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const receipt = await mutateWordbook(
        client,
        scope,
        word.id,
        saved,
        () => active.current && identity.current === expected,
      );
      if (receipt && active.current && identity.current === expected)
        setNotice(saved ? '已从生词本移除' : '已加入生词本');
    } catch (value) {
      if (active.current && identity.current === expected) setError(value);
    } finally {
      running.current = false;
      if (active.current && identity.current === expected) setBusy(false);
    }
  }
  return (
    <div className="study-bookmark">
      <WordSaveButton
        lemma={word.lemma}
        saved={saved}
        consolidated={consolidated}
        busy={busy}
        disabled={!user || entry.isFetching || !!entry.error || !entry.data}
        onClick={() => void toggle()}
      />
      {notice && (
        <p className="study-bookmark-notice" role="status">
          {notice} <Link to="/wordbook">查看</Link>
        </p>
      )}
      <ErrorNotice error={error || entry.error} onRetry={() => void entry.refetch()} />
    </div>
  );
}
