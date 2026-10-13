import { type ReactNode, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, LoaderCircle, Volume2, X, MoonStar } from 'lucide-react';
import { Link } from 'react-router-dom';
import { errorText } from '../lib/api';
import type { Word } from '../lib/types';

export function Heading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: ReactNode;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </header>
  );
}
export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{children}</section>;
}
export function Loading({ text = '正在读取你的记录…' }: { text?: string }) {
  return (
    <div className="loading-line" role="status">
      <LoaderCircle size={17} className="spin" /> {text}
    </div>
  );
}
export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="notice error" role="alert">
      <AlertCircle size={17} />
      <span>{errorText(error)}</span>
      {onRetry && <button onClick={onRetry}>重试</button>}
    </div>
  );
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice" role="status">
      {children}
    </div>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <MoonStar size={28} />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function LoginPrompt() {
  return (
    <Empty
      title="先连接你的学习账户。"
      description="记录属于你在本站的账户，登录后可以继续。"
      action={
        <Link className="button primary" to="/auth">
          登录 / 注册 <ArrowRight size={16} />
        </Link>
      }
    />
  );
}
export function AudioButton({ word }: { word: Word }) {
  const [status, setStatus] = useState('');
  const available = !!word.audioUrl || 'speechSynthesis' in window;
  return (
    <div className="audio-control">
      <button
        className="audio-button"
        disabled={!available}
        title={available ? undefined : '当前设备不支持合成发音'}
        aria-label={`播放 ${word.lemma} 发音`}
        onClick={() => {
          if (word.audioUrl) {
            const audio = new Audio(word.audioUrl);
            void audio
              .play()
              .then(() => setStatus('来源音频播放中'))
              .catch(() => {
                speak(word.lemma);
                setStatus('音频不可用，使用设备发音');
              });
          } else {
            speak(word.lemma);
            setStatus('使用设备合成发音');
          }
        }}
      >
        <Volume2 size={18} />
        <span>{word.audioUrl ? '来源发音' : '设备发音'}</span>
      </button>
      {status && <small role="status">{status}</small>}
    </div>
  );
}
function speak(lemma: string) {
  if ('speechSynthesis' in window) {
    speechSynthesis.cancel();
    const voice = new SpeechSynthesisUtterance(lemma);
    voice.lang = 'en-US';
    speechSynthesis.speak(voice);
  }
}
export function WordView({ word, focusSenseId }: { word: Word; focusSenseId?: string }) {
  const senses = [...(word.senses ?? [])].sort(
    (a, b) => Number(b.id === focusSenseId) - Number(a.id === focusSenseId),
  );
  return (
    <div className="word-content">
      <div className="word-title-row">
        <div>
          <h2 className="word-title">{word.lemma}</h2>
          <div className="phonetic">{word.phonetic || '音标待补充'}</div>
        </div>
        <AudioButton word={word} />
      </div>
      {senses.length > 0 && (
        <div className="meanings">
          {senses.map((sense, index) => (
            <div className="sense" key={sense.id}>
              <span className="tiny-label">
                {sense.pos || '词义'}
                {index === 0 ? ' · 当前重点' : ''}
              </span>
              <p className="meaning-zh">{sense.definitionZh}</p>
              {sense.definitionEn && <p className="meaning-en">{sense.definitionEn}</p>}
              {sense.exampleEn && (
                <blockquote>
                  <p>{sense.exampleEn}</p>
                  {sense.exampleZh && <small>{sense.exampleZh}</small>}
                </blockquote>
              )}
            </div>
          ))}
        </div>
      )}
      {word.sourceRef && <p className="source-line">内容来源 · {word.sourceRef}</p>}
    </div>
  );
}
export function Dialog({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="night-dialog"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button className="icon-button dialog-close" onClick={onClose} aria-label="关闭">
        <X size={19} />
      </button>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}
export function formatDate(date: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
}
