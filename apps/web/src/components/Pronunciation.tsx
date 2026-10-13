import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Square, Volume2 } from 'lucide-react';
import type { Word } from '../lib/types';

type Accent = 'en-US' | 'en-GB' | 'source';
type Playback = { phase: 'idle' | 'preparing' | 'playing' | 'ended' | 'error'; text: string };
let stopActivePlayback: (() => void) | null = null;

const errorMessages: Record<string, string> = {
  'audio-busy': '设备声音正在被其他程序使用，请稍后再试。',
  'audio-hardware': '设备音频输出不可用，请检查系统声音设置。',
  network: '设备语音服务连接失败，请检查网络或改用本地英语语音。',
  'not-allowed': '浏览器没有允许发音，请再次点击播放并检查声音权限。',
  'language-unavailable': '当前设备不支持这个英语口音，请选择另一口音。',
  'voice-unavailable': '所选设备语音不可用，请选择另一口音。',
  'synthesis-unavailable': '设备语音合成服务不可用，请稍后再试。',
  'synthesis-failed': '设备发音失败，请稍后再试。',
};
function voiceScore(voice: SpeechSynthesisVoice) {
  return (
    Number(voice.default) * 20 +
    Number(voice.localService) * 5 +
    Number(/Samantha|Alex|Ava|Daniel|Serena|Oliver|Google.*English/i.test(voice.name)) * 10
  );
}

export function AudioButton({ word }: { word: Word }) {
  const supported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const [accent, setAccent] = useState<Accent>(word.audioUrl ? 'source' : 'en-US');
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voicesReady, setVoicesReady] = useState(false);
  const [playback, setPlayback] = useState<Playback>({ phase: 'idle', text: '' });
  const audio = useRef<HTMLAudioElement | null>(null);
  const generation = useRef(0);
  const timeout = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  const voice = voices
    .filter((value) => value.lang.replace('_', '-').toLowerCase() === accent.toLowerCase())
    .sort((a, b) => voiceScore(b) - voiceScore(a))[0];
  const playing = playback.phase === 'preparing' || playback.phase === 'playing';
  const available = accent === 'source' ? !!word.audioUrl : supported && !!voice;
  const accentName = accent === 'en-GB' ? '英式' : '美式';

  function update(givenGeneration: number, value: Playback) {
    if (mounted.current && generation.current === givenGeneration) setPlayback(value);
  }
  const stop: () => void = useCallback(() => {
    generation.current++;
    window.clearTimeout(timeout.current);
    if (audio.current) {
      audio.current.pause();
      audio.current.src = '';
      audio.current = null;
    }
    if (supported && stopActivePlayback === stop) window.speechSynthesis.cancel();
    if (stopActivePlayback === stop) stopActivePlayback = null;
    if (mounted.current) setPlayback({ phase: 'idle', text: '播放已停止。' });
  }, [supported]);
  useEffect(() => {
    mounted.current = true;
    setAccent(word.audioUrl ? 'source' : 'en-US');
    setPlayback({ phase: 'idle', text: '' });
    return () => {
      mounted.current = false;
      stop();
    };
  }, [word.id, word.lemma, word.audioUrl, stop]);
  useEffect(() => {
    if (!supported) {
      setVoicesReady(true);
      return;
    }
    const load = () => {
      try {
        const current = window.speechSynthesis.getVoices();
        setVoices(current);
        if (current.length) setVoicesReady(true);
      } catch {
        setVoicesReady(true);
      }
    };
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    const timer = window.setTimeout(() => {
      load();
      setVoicesReady(true);
    }, 3000);
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', load);
      window.clearTimeout(timer);
    };
  }, [supported]);

  function play() {
    if (playing) {
      stop();
      return;
    }
    stopActivePlayback?.();
    stopActivePlayback = stop;
    const current = ++generation.current;
    if (accent === 'source' && word.audioUrl) {
      const element = new Audio(word.audioUrl);
      audio.current = element;
      setPlayback({ phase: 'preparing', text: '正在读取来源音频…' });
      element.onplaying = () => {
        window.clearTimeout(timeout.current);
        update(current, { phase: 'playing', text: '正在播放来源音频。' });
      };
      element.onended = () => update(current, { phase: 'ended', text: '来源音频播放完成。' });
      element.onerror = () => {
        window.clearTimeout(timeout.current);
        update(current, { phase: 'error', text: '来源音频无法播放，请改用可用的设备口音。' });
      };
      timeout.current = window.setTimeout(() => {
        update(current, { phase: 'error', text: '来源音频没有开始播放，请重试或选择设备发音。' });
        if (generation.current === current) {
          generation.current++;
          element.pause();
        }
      }, 10000);
      void element.play().catch(() => {
        window.clearTimeout(timeout.current);
        update(current, { phase: 'error', text: '浏览器未能播放来源音频，请重试或选择设备发音。' });
      });
      return;
    }
    if (!supported || !voice) {
      setPlayback({ phase: 'error', text: `当前设备未提供${accentName}英语语音。` });
      return;
    }
    const utterance = new SpeechSynthesisUtterance(word.lemma);
    utterance.lang = accent;
    utterance.voice = voice;
    utterance.rate = 0.85;
    setPlayback({ phase: 'preparing', text: `正在准备${accentName}设备发音…` });
    utterance.onstart = () => {
      window.clearTimeout(timeout.current);
      update(current, { phase: 'playing', text: `正在播放${accentName}设备合成发音。` });
    };
    utterance.onend = () =>
      update(current, { phase: 'ended', text: `${accentName}设备发音播放完成。` });
    utterance.onerror = (event) => {
      window.clearTimeout(timeout.current);
      update(current, {
        phase: 'error',
        text: errorMessages[event.error] ?? '设备发音未完成，请重试。',
      });
    };
    timeout.current = window.setTimeout(() => {
      update(current, { phase: 'error', text: '设备语音没有开始播放，请重试或选择另一口音。' });
      if (generation.current === current) {
        generation.current++;
        window.speechSynthesis.cancel();
      }
    }, 8000);
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      window.clearTimeout(timeout.current);
      update(current, { phase: 'error', text: '设备发音不可用，请检查系统语音设置。' });
    }
  }

  return (
    <div className="audio-control pronunciation-control">
      <div className="pronunciation-actions">
        <select
          aria-label={`${word.lemma} 发音口音`}
          value={accent}
          onChange={(event) => {
            stop();
            setAccent(event.target.value as Accent);
            setPlayback({ phase: 'idle', text: '' });
          }}
        >
          {word.audioUrl && <option value="source">来源音频</option>}
          <option value="en-US">美式 · 设备</option>
          <option value="en-GB">英式 · 设备</option>
        </select>
        <button
          className="audio-button"
          disabled={!available && !playing}
          aria-label={
            playing
              ? `停止 ${word.lemma} 发音`
              : `播放 ${word.lemma} ${accent === 'source' ? '来源' : accentName}发音`
          }
          onClick={play}
        >
          {playback.phase === 'preparing' ? (
            <LoaderCircle size={18} className="spin" />
          ) : playing ? (
            <Square size={16} />
          ) : (
            <Volume2 size={18} />
          )}
          <span>{playing ? '停止' : '播放'}</span>
        </button>
      </div>
      {playback.text && (
        <small role="status" className={playback.phase === 'error' ? 'rose-text' : ''}>
          {playback.text}
        </small>
      )}
      {!available && !playing && (
        <small role="status">
          {!supported
            ? '此浏览器未提供语音合成功能。'
            : !voicesReady
              ? '正在读取设备英语语音…'
              : `设备未提供${accentName}英语语音，请更换口音或安装系统英语语音。`}
        </small>
      )}
      {available && accent !== 'source' && (
        <small className="pronunciation-source">设备合成 · {voice?.name}</small>
      )}
    </div>
  );
}
