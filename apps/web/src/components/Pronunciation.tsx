import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Square, Volume2 } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { useLearningPreferences } from '../LearningPreferences';
import { mountUrl } from '../lib/api';
import type { Word, WordAudio } from '../lib/types';
import { usePackedAudio } from './usePackedAudio';
import { useScreenActive } from '../lib/screen-lifecycle';
interface PronunciationInfo {
  audio: WordAudio[];
  phonetics?: { ipa: string; region: string }[];
}
export function AudioButton({ word, autoPlay = false }: { word: Word; autoPlay?: boolean }) {
  const { scope } = useApp(),
    screenActive = useScreenActive();
  const { preferences, loaded } = useLearningPreferences();
  const preferred = preferences.accent === 'uk' ? 'UK' : 'US';
  const pronunciation = useRemote<{ pronunciation: PronunciationInfo }>(
    'pronunciation',
    `pronunciation/${encodeURIComponent(word.id)}`,
    !!word.id,
  );
  const info = pronunciation.data?.pronunciation;
  const entries = (info?.audio ?? word.audio ?? []).filter(
    (entry) =>
      entry.status === 'ready' &&
      ['US', 'UK'].includes(entry.accent) &&
      entry.url === `/api/v2/pronunciation/${encodeURIComponent(word.id)}/audio/${entry.accent}`,
  );
  const player = usePackedAudio(`${scope}:${word.id}`);
  const [selection, setSelection] = useState('');
  const attempted = useRef('');
  const accents: ('US' | 'UK')[] = preferred === 'UK' ? ['UK', 'US'] : ['US', 'UK'];
  function play(accent: 'US' | 'UK') {
    attempted.current = `${scope}:${word.id}`;
    if (player.playing && selection === accent) {
      player.stop();
      return;
    }
    const entry = entries.find((value) => value.accent === accent);
    if (entry) {
      setSelection(accent);
      player.play(mountUrl(entry.url));
    }
  }
  useEffect(() => {
    const identity = `${scope}:${word.id}`;
    if (
      !autoPlay ||
      !loaded ||
      !preferences.autoPlay ||
      !screenActive ||
      document.visibilityState === 'hidden' ||
      attempted.current === identity ||
      !entries.some((entry) => entry.accent === preferred)
    )
      return;
    attempted.current = identity;
    play(preferred);
  }, [
    autoPlay,
    loaded,
    preferences.autoPlay,
    preferred,
    screenActive,
    scope,
    word.id,
    entries.map((entry) => entry.id).join(':'),
  ]);
  return (
    <div className="audio-control pronunciation-control">
      <div className="pronunciation-lines">
        {accents.map((accent) => {
          const entry = entries.find((value) => value.accent === accent),
            name = accent === 'US' ? '美式' : '英式';
          const active = player.playing && selection === accent;
          const label = !entry ? `暂无${name}发音` : active ? `停止${name}发音` : `播放${name}发音`;
          const ipa =
            info?.phonetics?.find((value) => value.region === accent)?.ipa ||
            (accent === 'US' ? word.phoneticUs : word.phoneticUk);
          return (
            <div className="pronunciation-row" key={accent}>
              <span className="icon-action-hint">
                <button
                  type="button"
                  className="audio-button pronunciation-speaker"
                  disabled={!entry}
                  aria-label={
                    active
                      ? `停止 ${word.lemma} ${name}发音`
                      : entry
                        ? `播放 ${word.lemma} ${name}发音`
                        : `暂无 ${word.lemma} ${name}发音`
                  }
                  title={label}
                  aria-pressed={active}
                  onClick={() => play(accent)}
                >
                  {active && player.phase === 'loading' ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : active ? (
                    <Square size={14} />
                  ) : (
                    <Volume2 size={16} />
                  )}
                </button>
                <span className="icon-action-tooltip" role="tooltip">
                  {label}
                </span>
              </span>
              <span className="pronunciation-region-label">{accent === 'US' ? '美' : '英'}</span>
              <span className="pronunciation-ipa">{ipa || '暂无音标'}</span>
            </div>
          );
        })}
      </div>
      {player.phase === 'error' && (
        <small className="rose-text" role="alert">
          发音未能播放，请检查网络后重试。
        </small>
      )}
      <span className="sr-only" role="status">
        {player.phase === 'loading'
          ? '正在载入发音'
          : player.phase === 'playing'
            ? '正在播放发音'
            : ''}
      </span>
    </div>
  );
}
