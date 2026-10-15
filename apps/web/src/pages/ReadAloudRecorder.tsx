import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Square, Volume2 } from 'lucide-react';
import { ErrorNotice } from '../components/UI';
import { usePageLifetime } from './usePageLifetime';
import { claimAudio, releaseAudio } from '../lib/audio-manager';
import { screenDeactivateEvent, useScreenActive } from '../lib/screen-lifecycle';

const foreground = () => document.visibilityState !== 'hidden';

export function ReadAloudRecorder({ text, accent }: { text: string; accent: 'us' | 'uk' }) {
  const owner = usePageLifetime();
  const screenActive = useScreenActive();
  const visible = useRef(screenActive);
  visible.current = screenActive;
  const epoch = useRef(0);
  const speechOwner = useRef({}),
    recorderOwner = useRef({});
  const [recording, setRecording] = useState(false),
    [asking, setAsking] = useState(false),
    [seconds, setSeconds] = useState(0);
  const [url, setUrl] = useState(''),
    [error, setError] = useState<unknown>(null),
    [speaking, setSpeaking] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    objectUrl = useRef(''),
    speech = useRef<SpeechSynthesisUtterance | null>(null);
  const timer = useRef<number | undefined>(undefined),
    active = useRef(true),
    askingRef = useRef(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const matchingVoice = voices.find(
    (voice) => voice.lang.replace('_', '-').toLowerCase() === (accent === 'uk' ? 'en-gb' : 'en-us'),
  );
  const stopSpeech = useCallback(() => {
    if (speech.current && 'speechSynthesis' in window) {
      speech.current = null;
      window.speechSynthesis.cancel();
    }
    releaseAudio(speechOwner.current);
    if (active.current) setSpeaking(false);
  }, []);
  const clearMedia = useCallback(() => {
    epoch.current++;
    askingRef.current = false;
    window.clearInterval(timer.current);
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = '';
    releaseAudio(recorderOwner.current);
    stopSpeech();
    if (active.current) {
      setRecording(false);
      setAsking(false);
      setUrl('');
    }
  }, [stopSpeech]);
  useEffect(() => {
    if (!screenActive) clearMedia();
  }, [screenActive, clearMedia]);
  useEffect(() => {
    active.current = true;
    const load = () => {
      if ('speechSynthesis' in window) setVoices(window.speechSynthesis.getVoices());
    };
    load();
    const hidden = () => {
      if (document.visibilityState === 'hidden') clearMedia();
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener(screenDeactivateEvent, clearMedia);
    if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => {
      active.current = false;
      clearMedia();
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener(screenDeactivateEvent, clearMedia);
      if ('speechSynthesis' in window)
        window.speechSynthesis.removeEventListener('voiceschanged', load);
    };
  }, [owner.scope]);
  function play() {
    if (
      !matchingVoice ||
      !('speechSynthesis' in window) ||
      !visible.current ||
      document.visibilityState === 'hidden'
    )
      return;
    if (speech.current) {
      stopSpeech();
      return;
    }
    claimAudio(speechOwner.current, stopSpeech);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = matchingVoice;
    utterance.lang = accent === 'uk' ? 'en-GB' : 'en-US';
    utterance.rate = 0.85;
    speech.current = utterance;
    setSpeaking(true);
    setError(null);
    utterance.onend = () => {
      if (speech.current !== utterance) return;
      speech.current = null;
      releaseAudio(speechOwner.current);
      if (active.current) setSpeaking(false);
    };
    utterance.onerror = () => {
      if (speech.current !== utterance) return;
      speech.current = null;
      releaseAudio(speechOwner.current);
      if (active.current) {
        setSpeaking(false);
        setError(new Error('设备语音未能播放，请手动朗读。'));
      }
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }
  async function record() {
    if (askingRef.current || recording || !visible.current || !foreground()) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError(new Error('当前浏览器暂不能录音，可以先自己朗读。'));
      return;
    }
    askingRef.current = true;
    setAsking(true);
    setError(null);
    const request = owner.capture();
    const requestEpoch = epoch.current;
    const requestAudioOwner = {};
    let requestInput: MediaStream | null = null;
    try {
      const input = await navigator.mediaDevices.getUserMedia({ audio: true });
      requestInput = input;
      if (
        !owner.isCurrent(request) ||
        !active.current ||
        !visible.current ||
        requestEpoch !== epoch.current ||
        !foreground()
      ) {
        input.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = input;
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      const made = new MediaRecorder(input, mime ? { mimeType: mime } : undefined);
      recorder.current = made;
      const chunks: BlobPart[] = [];
      let bytes = 0;
      made.ondataavailable = (event) => {
        if (event.data.size) {
          bytes += event.data.size;
          if (bytes <= 8 * 1024 * 1024) chunks.push(event.data);
          else {
            if (made.state === 'recording') made.stop();
            if (active.current && requestEpoch === epoch.current && visible.current)
              setError(new Error('录音达到大小上限，请使用较短片段。'));
          }
        }
      };
      made.onstop = () => {
        input.getTracks().forEach((track) => track.stop());
        releaseAudio(requestAudioOwner);
        if (
          !owner.isCurrent(request) ||
          !active.current ||
          requestEpoch !== epoch.current ||
          !visible.current
        )
          return;
        window.clearInterval(timer.current);
        if (stream.current === input) stream.current = null;
        if (recorder.current === made) recorder.current = null;
        setRecording(false);
        if (bytes > 8 * 1024 * 1024 || !chunks.length) return;
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = URL.createObjectURL(
          new Blob(chunks, { type: made.mimeType || 'audio/webm' }),
        );
        setUrl(objectUrl.current);
      };
      made.onerror = () => {
        input.getTracks().forEach((track) => track.stop());
        releaseAudio(requestAudioOwner);
        if (active.current && requestEpoch === epoch.current) {
          window.clearInterval(timer.current);
          setRecording(false);
          setError(new Error('录音未完成，请重试。'));
        }
      };
      recorderOwner.current = requestAudioOwner;
      claimAudio(requestAudioOwner, () => {
        if (made.state === 'recording') made.stop();
      });
      made.start(500);
      setRecording(true);
      setSeconds(0);
      const started = Date.now();
      timer.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1000);
        if (active.current && requestEpoch === epoch.current) setSeconds(elapsed);
        if (elapsed >= 60 && made.state === 'recording') made.stop();
      }, 250);
    } catch {
      if (owner.isCurrent(request) && requestEpoch === epoch.current)
        setError(new Error('未取得麦克风权限，或设备暂时不可用。可以继续手动朗读。'));
      requestInput?.getTracks().forEach((track) => track.stop());
      releaseAudio(requestAudioOwner);
    } finally {
      if (owner.isCurrent(request) && requestEpoch === epoch.current) {
        askingRef.current = false;
        setAsking(false);
      }
    }
  }
  return (
    <section className="mobile-recorder">
      <h3>听一遍，再自己读一遍</h3>
      <div className="mobile-recorder-controls">
        <button className="button ghost" disabled={!matchingVoice || recording} onClick={play}>
          <Volume2 size={16} />
          {speaking ? '停止朗读' : `${accent === 'uk' ? '英式' : '美式'}朗读`}
        </button>
        <button
          className="button primary"
          disabled={asking}
          onClick={() => (recording ? recorder.current?.stop() : void record())}
        >
          {recording ? <Square size={16} /> : <Mic size={16} />}{' '}
          {asking ? '等待麦克风权限…' : recording ? `停止录音 · ${seconds}s` : '录一段自己的朗读'}
        </button>
      </div>
      {!matchingVoice && (
        <p className="mobile-caption">
          暂无{accent === 'uk' ? '英式' : '美式'}朗读示范，仍可自己朗读和录音。
        </p>
      )}
      {url && (
        <>
          <audio controls src={url} />
          <button
            className="text-link"
            onClick={() => {
              URL.revokeObjectURL(objectUrl.current);
              objectUrl.current = '';
              setUrl('');
            }}
          >
            删除本段录音
          </button>
        </>
      )}
      <p className="mobile-caption">
        每段最多60秒，仅在本次练习中保留，可回放和删除；不上传，也不生成发音分数。
      </p>
      <ErrorNotice error={error} />
    </section>
  );
}
