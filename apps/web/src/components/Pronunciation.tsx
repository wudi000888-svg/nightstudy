import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Square, Volume2 } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { ApiError, mountUrl, post } from '../lib/api';
import type { Word, WordAudio } from '../lib/types';

type Selection = 'US' | 'UK' | 'device-US' | 'device-UK';
type Playback = { phase: 'idle' | 'preparing' | 'playing' | 'ended' | 'error'; text: string };
interface PronunciationInfo {
  audio: WordAudio[];
  generationAvailable?: boolean;
  phonetics?: { ipa: string; region: string; sourceRef?: string }[];
}
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
function safeAudio(value: WordAudio, wordId: string) {
  return (
    value.status === 'ready' &&
    value.url === `/api/v2/pronunciation/${encodeURIComponent(wordId)}/audio/${value.accent}`
  );
}
function sourceLink(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function AudioButton({ word }: { word: Word }) {
  const { user } = useApp();
  const supported =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    'SpeechSynthesisUtterance' in window;
  const pronunciation = useRemote<{ pronunciation: PronunciationInfo }>(
    'pronunciation',
    `pronunciation/${encodeURIComponent(word.id)}`,
    !!word.id,
  );
  const [prepared, setPrepared] = useState<PronunciationInfo | null>(null);
  const [preparingServer, setPreparingServer] = useState(false);
  const [prepareSeconds, setPrepareSeconds] = useState(0);
  const [prepareError, setPrepareError] = useState<unknown>(null);
  const [prepareNote, setPrepareNote] = useState('');
  const info = prepared ?? pronunciation.data?.pronunciation;
  const entries = (info?.audio ?? word.audio ?? []).filter((entry) => safeAudio(entry, word.id));
  const audioUs = entries
    .filter((entry) => entry.accent === 'US')
    .sort((a, b) => Number(b.kind === 'recorded') - Number(a.kind === 'recorded'))[0];
  const audioUk = entries
    .filter((entry) => entry.accent === 'UK')
    .sort((a, b) => Number(b.kind === 'recorded') - Number(a.kind === 'recorded'))[0];
  const [selection, setSelection] = useState<Selection>('US');
  const [deviceRegion, setDeviceRegion] = useState<'US' | 'UK'>('US');
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voicesReady, setVoicesReady] = useState(false);
  const [playback, setPlayback] = useState<Playback>({ phase: 'idle', text: '' });
  const element = useRef<HTMLAudioElement | null>(null);
  const generation = useRef(0);
  const timeout = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  const wordIdentity = useRef(word.id);
  const activeSelection = useRef<Selection | null>(null);
  const device = selection.startsWith('device-');
  const deviceVoice = voices
    .filter(
      (value) =>
        value.lang.replace('_', '-').toLowerCase() === (deviceRegion === 'UK' ? 'en-gb' : 'en-us'),
    )
    .sort((a, b) => voiceScore(b) - voiceScore(a))[0];
  const playing = playback.phase === 'preparing' || playback.phase === 'playing';
  const hasUsIpa =
    !!info?.phonetics?.some((value) => value.region === 'US' && value.ipa.trim()) ||
    !!word.phoneticUs?.trim();
  const hasUkIpa =
    !!info?.phonetics?.some((value) => value.region === 'UK' && value.ipa.trim()) ||
    !!word.phoneticUk?.trim();
  function update(requestId: number, value: Playback) {
    if (mounted.current && generation.current === requestId) setPlayback(value);
  }
  const stop: () => void = useCallback(() => {
    generation.current++;
    window.clearTimeout(timeout.current);
    if (element.current) {
      element.current.pause();
      element.current.src = '';
      element.current = null;
    }
    if (supported && stopActivePlayback === stop) window.speechSynthesis.cancel();
    if (stopActivePlayback === stop) stopActivePlayback = null;
    activeSelection.current = null;
    if (mounted.current) setPlayback({ phase: 'idle', text: '播放已停止。' });
  }, [supported]);
  useEffect(() => {
    mounted.current = true;
    wordIdentity.current = word.id;
    setPrepared(null);
    setPreparingServer(false);
    setPrepareError(null);
    setPrepareNote('');
    setSelection('US');
    setDeviceRegion('US');
    setPlayback({ phase: 'idle', text: '' });
    return () => {
      mounted.current = false;
      stop();
    };
  }, [word.id, word.lemma, stop]);
  useEffect(() => {
    if (!preparingServer) {
      setPrepareSeconds(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(
      () => setPrepareSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [preparingServer]);
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
  async function refreshSources(clearError = true) {
    const targetId = word.id;
    if (clearError) setPrepareError(null);
    const result = await pronunciation.refetch();
    if (!mounted.current || wordIdentity.current !== targetId) return;
    if (result.error) {
      if (clearError) setPrepareError(result.error);
    } else if (result.data) setPrepared(result.data.pronunciation);
  }
  async function prepareSources() {
    if (!user || preparingServer || !info?.generationAvailable) return;
    const targetId = word.id;
    stop();
    setPreparingServer(true);
    setPrepareError(null);
    setPrepareNote('');
    try {
      const result = await post<{ pronunciation: PronunciationInfo }>(
        `pronunciation/${encodeURIComponent(targetId)}/prepare`,
        {},
      );
      if (!mounted.current || wordIdentity.current !== targetId) return;
      setPrepared(result.pronunciation);
      setPrepareNote('发音已准备好，请再点一下喇叭。');
      await refreshSources(false);
    } catch (error) {
      if (!mounted.current || wordIdentity.current !== targetId) return;
      setPrepareError(error);
      if (error instanceof ApiError && error.code === 'audio_preparing')
        await refreshSources(false);
    } finally {
      if (mounted.current && wordIdentity.current === targetId) setPreparingServer(false);
    }
  }
  async function explainAudioFailure(
    audio: HTMLAudioElement,
    source: WordAudio,
    requestId: number,
  ) {
    const codecError = audio.error?.code === 3 || audio.error?.code === 4;
    let message = codecError
      ? '浏览器暂时无法播放这段发音，请重试。'
      : '发音未能载入，请检查网络后重试。';
    try {
      const response = await fetch(mountUrl(source.url), {
        method: 'HEAD',
        credentials: 'include',
      });
      if (!response.ok) {
        const diagnostic = await fetch(mountUrl(source.url), { credentials: 'include' });
        const detail = (await diagnostic.json().catch(() => ({}))) as { code?: string };
        if (detail.code === 'audio_asset_invalid') message = '这段发音暂时不可用，请稍后重试。';
        else if (detail.code === 'audio_asset_unavailable')
          message = '这段发音暂时不可用，请稍后重试。';
        else if (detail.code === 'audio_not_ready') message = '发音尚未准备好，请稍后重试。';
        else message = '暂时无法读取发音，请稍后重试。';
      }
    } catch {
      message = '网络未连接，请恢复连接后重试。';
    }
    update(requestId, { phase: 'error', text: message });
  }
  function play(next: Selection) {
    if (preparingServer) return;
    setPrepareNote('');
    if (playing && activeSelection.current === next) {
      stop();
      return;
    }
    if (stopActivePlayback && stopActivePlayback !== stop) stopActivePlayback();
    stop();
    stopActivePlayback = stop;
    activeSelection.current = next;
    setSelection(next);
    const region = next.endsWith('UK') ? 'UK' : 'US';
    const device = next.startsWith('device-');
    const selectedAudio = region === 'UK' ? audioUk : audioUs;
    const accentName = region === 'UK' ? '英式' : '美式';
    const soundName = '发音';
    const language = region === 'UK' ? 'en-GB' : 'en-US';
    const voice = voices
      .filter((value) => value.lang.replace('_', '-').toLowerCase() === language.toLowerCase())
      .sort((a, b) => voiceScore(b) - voiceScore(a))[0];
    const requestId = ++generation.current;
    if (!device && selectedAudio) {
      const audio = new Audio(mountUrl(selectedAudio.url));
      element.current = audio;
      setPlayback({ phase: 'preparing', text: `正在载入${accentName}${soundName}…` });
      audio.onplaying = () => {
        window.clearTimeout(timeout.current);
        update(requestId, { phase: 'playing', text: `正在播放${accentName}${soundName}。` });
      };
      audio.onended = () => {
        window.clearTimeout(timeout.current);
        update(requestId, { phase: 'ended', text: `${accentName}${soundName}播放完成。` });
      };
      audio.onerror = () => {
        window.clearTimeout(timeout.current);
        update(requestId, { phase: 'error', text: '发音未能播放，请稍候…' });
        void explainAudioFailure(audio, selectedAudio, requestId);
      };
      timeout.current = window.setTimeout(() => {
        update(requestId, {
          phase: 'error',
          text: '发音暂未开始播放，请再点一下喇叭。',
        });
        if (generation.current === requestId) {
          generation.current++;
          audio.pause();
        }
      }, 10000);
      void audio.play().catch(() => {
        window.clearTimeout(timeout.current);
        update(requestId, {
          phase: 'error',
          text: '浏览器未能播放发音，请再点一下喇叭。',
        });
      });
      return;
    }
    if (!device) {
      setPlayback({
        phase: 'error',
        text: `暂无${accentName}发音。`,
      });
      return;
    }
    if (!supported || !voice) {
      setPlayback({ phase: 'error', text: `当前设备未提供${accentName}英语语音。` });
      return;
    }
    const utterance = new SpeechSynthesisUtterance(word.lemma);
    utterance.lang = language;
    utterance.voice = voice;
    utterance.rate = 0.85;
    setPlayback({ phase: 'preparing', text: `正在准备${accentName}设备发音…` });
    utterance.onstart = () => {
      window.clearTimeout(timeout.current);
      update(requestId, { phase: 'playing', text: `正在播放${accentName}设备合成发音。` });
    };
    utterance.onend = () => {
      window.clearTimeout(timeout.current);
      update(requestId, { phase: 'ended', text: `${accentName}设备发音播放完成。` });
    };
    utterance.onerror = (event) => {
      window.clearTimeout(timeout.current);
      update(requestId, {
        phase: 'error',
        text: errorMessages[event.error] ?? '设备发音未完成，请重试。',
      });
    };
    timeout.current = window.setTimeout(() => {
      update(requestId, { phase: 'error', text: '设备语音尚未开始播放，请重试或更换口音。' });
      if (generation.current === requestId) {
        generation.current++;
        window.speechSynthesis.cancel();
      }
    }, 8000);
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      window.clearTimeout(timeout.current);
      update(requestId, { phase: 'error', text: '设备发音不可用，请检查系统语音设置。' });
    }
  }
  const canPrepare = !!user && !!info?.generationAvailable && hasUsIpa && hasUkIpa;
  const preparationError = prepareError
    ? prepareError instanceof ApiError && prepareError.code === 'audio_preparing'
      ? '发音准备中，请稍后再试。'
      : prepareError instanceof ApiError && prepareError.status === 429
        ? '请稍后再试。'
        : '暂时无法准备发音，请稍后重试。'
    : '';
  const failure =
    preparationError ||
    (playback.phase === 'error' ? playback.text : '') ||
    (pronunciation.error && !audioUs && !audioUk ? '暂时无法读取发音。' : '');
  return (
    <div className="audio-control pronunciation-control">
      <div className="pronunciation-lines">
        {(['US', 'UK'] as const).map((accent) => {
          const audio = accent === 'US' ? audioUs : audioUk;
          const active = playing && selection === accent;
          const ipa =
            info?.phonetics?.find((entry) => entry.region === accent)?.ipa ||
            (accent === 'US' ? word.phoneticUs : word.phoneticUk);
          const name = accent === 'US' ? '美式' : '英式';
          const waiting = preparingServer || (active && playback.phase === 'preparing');
          return (
            <div className="pronunciation-row" key={accent}>
              <button
                type="button"
                className="audio-button pronunciation-speaker"
                disabled={preparingServer || (!audio && !canPrepare)}
                aria-label={
                  active
                    ? `停止 ${word.lemma} ${name}发音`
                    : !audio && !canPrepare
                      ? `暂无 ${word.lemma} ${name}发音`
                      : `播放 ${word.lemma} ${name}发音`
                }
                title={!audio && !canPrepare ? `暂无${name}发音` : `${name}发音`}
                aria-pressed={active}
                onClick={() => (audio ? play(accent) : void prepareSources())}
              >
                <span className="pronunciation-accent">{accent}</span>
                {waiting ? (
                  <LoaderCircle size={16} className="spin" />
                ) : active ? (
                  <Square size={14} />
                ) : (
                  <Volume2 size={16} />
                )}
              </button>
              <span className="pronunciation-ipa">{ipa || '暂无音标'}</span>
            </div>
          );
        })}
      </div>
      <span className="sr-only" role="status">
        {preparingServer
          ? `正在准备发音，已等待${prepareSeconds}秒。`
          : prepareNote || playback.text || (pronunciation.isPending ? '正在载入发音。' : '')}
      </span>
      {prepareNote && <small role="status">{prepareNote}</small>}
      {failure && (
        <small className="rose-text" role="alert">
          {failure}
        </small>
      )}
    </div>
  );
}
