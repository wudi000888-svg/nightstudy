import { type ReactNode, useEffect, useId, useRef } from 'react';
import { AlertCircle, ArrowRight, LoaderCircle, X, MoonStar } from 'lucide-react';
import { Link } from 'react-router-dom';
import { errorText } from '../lib/api';
import type { Word } from '../lib/types';
import { AudioButton } from './Pronunciation';
import { dictionaryText } from '../lib/dictionary';
import { InteractiveEnglish } from './InteractiveEnglish';
export { AudioButton } from './Pronunciation';

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
export function WordView({
  word,
  focusSenseId,
  hideMeanings = false,
}: {
  word: Word;
  focusSenseId?: string;
  hideMeanings?: boolean;
}) {
  const senses = [...(hideMeanings ? [] : (word.senses ?? []))]
    .filter((sense) => (sense.definitionZh ?? '').trim() || sense.definitionEn?.trim())
    .sort((a, b) => Number(b.id === focusSenseId) - Number(a.id === focusSenseId));
  return (
    <div className="word-content">
      <div className="word-title-row">
        <div>
          <h2 className="word-title">{word.lemma}</h2>
          <div className="phonetic">
            {word.phoneticUs || word.phoneticUk ? (
              <>
                {word.phoneticUs && (
                  <span>
                    <small>美式</small> {word.phoneticUs}
                  </span>
                )}
                {word.phoneticUk && (
                  <span>
                    <small>英式</small> {word.phoneticUk}
                  </span>
                )}
              </>
            ) : word.phonetics?.length ? (
              word.phonetics.map((value) => (
                <span key={value.text} title="词库读音标注，未区分英美">
                  {value.text}
                </span>
              ))
            ) : (
              word.phonetic || '来源暂未提供音标'
            )}
          </div>
          {word.phoneticUs || word.phoneticUk
            ? word.phoneticSource && (
                <details className="phonetic-caption">
                  <summary>音标出处</summary>
                  <span>{word.phoneticSource}</span>
                </details>
              )
            : !!word.phonetics?.length && (
                <span className="phonetic-caption">词库音标 · 来源未分型</span>
              )}
        </div>
        <AudioButton word={word} />
      </div>
      {senses.length > 0 && (
        <div className="meanings">
          {senses.map((sense, index) => (
            <div className="sense" key={sense.id}>
              <span className="tiny-label">
                {sense.pos || '词义'}
                {sense.id === focusSenseId ? ' · 当前重点' : ` · 释义 ${index + 1}`}
              </span>
              {dictionaryText(sense.definitionZh) && (
                <p className="meaning-zh">
                  <InteractiveEnglish text={dictionaryText(sense.definitionZh)} />
                </p>
              )}
              {dictionaryText(sense.definitionEn) && (
                <p className="meaning-en">
                  <InteractiveEnglish text={dictionaryText(sense.definitionEn)} />
                </p>
              )}
              {sense.exampleEn?.trim() && (
                <blockquote>
                  <p>
                    <InteractiveEnglish text={dictionaryText(sense.exampleEn)} />
                  </p>
                  {dictionaryText(sense.exampleZh) && (
                    <small>
                      <InteractiveEnglish text={dictionaryText(sense.exampleZh)} />
                    </small>
                  )}
                  {sense.exampleSource && (
                    <small className="source-line">
                      语境来源 · {sense.exampleSource.reference}
                      {sense.exampleSource.license ? ` · ${sense.exampleSource.license}` : ''}
                    </small>
                  )}
                </blockquote>
              )}
              {(sense.source || sense.sourceRef) && (
                <p className="source-line">
                  释义来源 · {sense.source?.reference || sense.sourceRef}
                  {sense.source?.license ? ` · ${sense.source.license}` : ''}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {!hideMeanings && word.senses && senses.length === 0 && (
        <p className="fine-print">该词条来源暂未提供可展示的释义。</p>
      )}
      {!hideMeanings && (word.source?.reference || word.sourceRef) && (
        <div className="word-source-detail">
          <p className="source-line">内容来源 · {word.source?.reference || word.sourceRef}</p>
          {word.source?.license && (
            <p className="source-line">主来源许可 · {word.source.license}</p>
          )}
          {word.source?.wordHasSiteEdits && (
            <p className="source-line">
              本站编辑记录 · {word.source.siteEditVersion || word.contentVersion}（词条级记录）
            </p>
          )}
          {sourceLink(word.source?.sourceUrl) && (
            <a
              className="text-link"
              href={sourceLink(word.source?.sourceUrl)}
              target="_blank"
              rel="noopener noreferrer"
            >
              查看来源信息 ↗
            </a>
          )}
          {!!word.sources?.length && (
            <details className="dictionary-pack-details">
              <summary>查看来源与许可 · {word.sources.length} 个数据包</summary>
              {word.sources.map((source) => (
                <div className="dictionary-pack" key={source.id}>
                  <strong>{source.id}</strong>
                  <span>
                    版本 {source.version} · 许可 {source.license}
                  </span>
                  {sourceLink(source.sourceUrl) && (
                    <a
                      className="text-link"
                      href={sourceLink(source.sourceUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      数据包来源 ↗
                    </a>
                  )}
                </div>
              ))}
            </details>
          )}
        </div>
      )}
    </div>
  );
}
function sourceLink(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
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
  const titleId = useId();
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
      aria-labelledby={titleId}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button className="icon-button dialog-close" onClick={onClose} aria-label="关闭">
        <X size={19} />
      </button>
      <h2 id={titleId}>{title}</h2>
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
