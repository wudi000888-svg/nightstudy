import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Square, Volume2 } from 'lucide-react';
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
  const [identity, setIdentity] = useState({ text: '', hash: '' }),
    [visible, setVisible] = useState(false),
    [selected, setSelected] = useState('');
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let alive = true;
    if (!normalized || normalized.length > 2000 || !globalThis.crypto?.subtle) return;
    void sentenceAudioHash(normalized)
      .then((hash) => {
        if (alive) setIdentity({ text: normalized, hash });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [normalized]);
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
  const entries =
    info?.textHash === hash &&
    typeof info.text === 'string' &&
    normalizeSentence(info.text) === normalized
      ? info.audio.filter(
          (entry) =>
            entry.status === 'ready' &&
            ['US', 'UK'].includes(entry.accent) &&
            entry.url === `/api/v2/sentence-audio/${hash}/audio/${entry.accent}`,
        )
      : [];
  const player = usePackedAudio(`${scope}:${normalized}:${accent ?? 'both'}`);
  return (
    <span ref={root} className="sentence-audio-controls">
      {(accent ? [accent] : ['US', 'UK']).map((region) => {
        const entry = entries.find((value) => value.accent === region),
          name = region === 'US' ? '美式' : '英式',
          active = player.playing && selected === region;
        const label = active
          ? `停止${name}例句朗读`
          : entry
            ? `播放${name}例句朗读`
            : `暂无${name}例句发音`;
        return (
          <button
            type="button"
            key={region}
            className="sentence-audio-button"
            title={label}
            aria-label={label}
            aria-pressed={active}
            disabled={!entry || disabled}
            onClick={() => {
              if (disabled) return;
              if (active) player.stop();
              else if (entry) {
                setSelected(region);
                player.play(mountUrl(entry.url));
              }
            }}
          >
            {active && player.phase === 'loading' ? (
              <LoaderCircle size={14} className="spin" />
            ) : active ? (
              <Square size={13} />
            ) : (
              <Volume2 size={15} />
            )}
            <span>{region === 'US' ? '美' : '英'}</span>
          </button>
        );
      })}
      {player.phase === 'error' && <small role="alert">未能播放，请重试。</small>}
    </span>
  );
}
