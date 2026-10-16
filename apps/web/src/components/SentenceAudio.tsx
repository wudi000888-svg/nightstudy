import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, Square, Volume2 } from 'lucide-react';
import { useRemote, useApp } from '../AppContext';
import { mountUrl } from '../lib/api';
import { usePackedAudio } from './usePackedAudio';
import { normalizeSentence, sentenceAudioHash } from '../lib/sentence-audio';
export function SentenceAudioButton({
  text,
  accent,
  disabled = false,
}: {
  text: string;
  accent?: 'US' | 'UK';
  disabled?: boolean;
}) {
  const normalized = normalizeSentence(text),
    { scope } = useApp();
  const [identity, setIdentity] = useState({ text: '', hash: '', failed: false }),
    [visible, setVisible] = useState(false),
    [selected, setSelected] = useState(''),
    [retryHash, setRetryHash] = useState(0);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let alive = true;
    if (!visible || !normalized || normalized.length > 3000) return;
    if (!globalThis.crypto?.subtle) {
      setIdentity({ text: normalized, hash: '', failed: true });
      return;
    }
    void sentenceAudioHash(normalized)
      .then((hash) => {
        if (alive) setIdentity({ text: normalized, hash, failed: false });
      })
      .catch(() => {
        if (alive) setIdentity({ text: normalized, hash: '', failed: true });
      });
    return () => {
      alive = false;
    };
  }, [normalized, visible, retryHash]);
  useEffect(() => {
    if (!root.current || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '80px' },
    );
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const hash = identity.text === normalized ? identity.hash : '';
  const sources = useRemote<{
    sentence: {
      textHash: string;
      text: string | null;
      audio: { accent: string; url: string; status: string }[];
    };
  }>('sentence-audio', `sentence-audio/${hash}`, !!hash && visible);
  const info = sources.data?.sentence;
  const validResponse =
    info?.textHash === hash &&
    Array.isArray(info.audio) &&
    (typeof info.text === 'string'
      ? normalizeSentence(info.text) === normalized
      : info.text === null && info.audio.length === 0);
  const entries =
    validResponse && info
      ? info.audio.filter(
          (entry) =>
            entry.status === 'ready' &&
            ['US', 'UK'].includes(entry.accent) &&
            entry.url === `/api/v2/sentence-audio/${hash}/audio/${entry.accent}`,
        )
      : [];
  const player = usePackedAudio(`${scope}:${normalized}:${accent ?? 'both'}`);
  const failed =
    (identity.text === normalized && identity.failed) ||
    !!sources.error ||
    (!!sources.data && !validResponse);
  const pending = !failed && (!visible || !hash || !sources.data || !!sources.isFetching);
  function retry() {
    if (!hash) setRetryHash((value) => value + 1);
    else void sources.refetch();
  }
  if (!normalized || normalized.length > 3000) return null;
  return (
    <span ref={root} className="sentence-audio-controls">
      {(accent ? [accent] : ['US', 'UK']).map((region) => {
        const entry = entries.find((value) => value.accent === region),
          name = region === 'US' ? '美式' : '英式',
          active = player.playing && selected === region,
          loading = !entry && (pending || !!sources.isFetching);
        const label = active
          ? `停止${name}例句朗读`
          : entry
            ? `播放${name}例句朗读`
            : loading
              ? `正在读取${name}例句发音`
              : failed
                ? `重新读取${name}例句发音`
                : `暂无${name}例句发音`;
        return (
          <button
            type="button"
            key={region}
            className="sentence-audio-button"
            title={label}
            aria-label={label}
            aria-pressed={active}
            aria-busy={loading || (active && player.phase === 'loading')}
            disabled={disabled || loading || (!entry && !failed)}
            onClick={() => {
              if (disabled || loading) return;
              if (active) player.stop();
              else if (entry) {
                setSelected(region);
                player.play(mountUrl(entry.url));
              } else if (failed) retry();
            }}
          >
            {(active && player.phase === 'loading') || (loading && visible) ? (
              <LoaderCircle size={14} className="spin" />
            ) : active ? (
              <Square size={13} />
            ) : !entry && failed ? (
              <RefreshCw size={15} />
            ) : (
              <Volume2 size={15} />
            )}
            <span>{region === 'US' ? '美' : '英'}</span>
          </button>
        );
      })}
      {failed && !sources.isFetching && <small role="status">发音暂未读取，点按重试。</small>}
      {player.phase === 'error' && <small role="alert">未能播放，请重试。</small>}
    </span>
  );
}
