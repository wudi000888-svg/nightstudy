import { type ReactNode, useEffect, useId, useRef } from 'react';
import { AlertCircle, ArrowRight, LoaderCircle, Star, X, MoonStar } from 'lucide-react';
import { Link } from 'react-router-dom';
import { errorText } from '../lib/api';
import type { Word } from '../lib/types';
import { AudioButton } from './Pronunciation';
import { dictionaryText } from '../lib/dictionary';
import { StudyWordDetails } from './study/StudyWordDetails';
import { DictionaryMeanings } from './DictionaryMeanings';
import './study/mobile-study.css';
import { beforeAppBackEvent, useScreenActive } from '../lib/screen-lifecycle';
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
export function IconActionHint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="icon-action-hint">
      {children}
      <span className="icon-action-tooltip" role="tooltip">
        {label}
      </span>
    </span>
  );
}
export function WordSaveButton({
  lemma,
  saved,
  busy = false,
  disabled = false,
  consolidated = false,
  onClick,
}: {
  lemma: string;
  saved: boolean;
  busy?: boolean;
  disabled?: boolean;
  consolidated?: boolean;
  onClick: () => void;
}) {
  return (
    <IconActionHint
      label={
        busy ? '正在保存…' : saved ? (consolidated ? '移除已巩固收藏' : '移出生词本') : '加入生词本'
      }
    >
      <button
        type="button"
        className={`icon-button word-save-button${saved ? ' saved' : ''}`}
        disabled={busy || disabled}
        aria-label={
          busy
            ? '正在保存'
            : saved
              ? consolidated
                ? `移除 ${lemma} 已巩固收藏`
                : `从生词本移除 ${lemma}`
              : `加入生词本 ${lemma}`
        }
        aria-pressed={saved}
        onClick={onClick}
      >
        {busy ? (
          <LoaderCircle size={19} className="spin" />
        ) : (
          <Star size={20} fill={saved ? 'currentColor' : 'none'} />
        )}
      </button>
    </IconActionHint>
  );
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
function fieldMetadata(metadata: Record<string, unknown> | undefined, field: string) {
  const value = metadata?.[field];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function ContentTags({
  metadata,
  field,
}: {
  metadata?: Record<string, unknown>;
  field: string;
}) {
  const source = fieldMetadata(metadata, field);
  if (!source) return null;
  const kind =
    source.kind === 'machine-translation'
      ? '机器翻译'
      : source.kind === 'generated'
        ? field.startsWith('example')
          ? '生成例句'
          : '机器生成'
        : source.kind === 'original-authoring'
          ? '原创翻译'
          : null;
  if (!kind && source.review !== 'pending') return null;
  return (
    <span className="content-statuses" lang="zh-CN">
      {kind && (
        <span
          className={`content-status ${source.kind === 'original-authoring' ? 'authored' : 'machine'}`}
        >
          {kind}
        </span>
      )}
      {source.review === 'pending' && <span className="content-status pending">待校对</span>}
    </span>
  );
}
function MetadataSources({
  metadata,
  fields,
}: {
  metadata?: Record<string, unknown>;
  fields: { key: string; label: string; present: boolean }[];
}) {
  return (
    <>
      {fields.map(({ key, label, present }) => {
        const source = present && fieldMetadata(metadata, key);
        if (!source) return null;
        const kind =
          source.kind === 'machine-translation'
            ? '机器翻译'
            : source.kind === 'generated'
              ? '生成内容'
              : source.kind === 'corpus'
                ? '语料来源'
                : source.kind === 'original-authoring'
                  ? '原创翻译'
                  : '来源信息';
        return (
          <div className="content-field-source" key={key}>
            <p className="source-line">
              {label} · {kind}
              {source.review === 'pending' ? ' · 待校对' : ''}
              {typeof source.license === 'string' ? ` · ${source.license}` : ''}
            </p>
            {source.kind !== 'original-authoring' && typeof source.model === 'string' && (
              <p className="source-line">模型 · {source.model}</p>
            )}
            {source.kind !== 'original-authoring' && typeof source.modelAuthor === 'string' && (
              <p className="source-line">模型作者 · {source.modelAuthor}</p>
            )}
            {source.kind !== 'original-authoring' && typeof source.modelLicense === 'string' && (
              <p className="source-line">模型许可 · {source.modelLicense}</p>
            )}
            {source.kind !== 'original-authoring' &&
              typeof source.modelUrl === 'string' &&
              sourceLink(source.modelUrl) && (
                <a
                  className="text-link"
                  href={sourceLink(source.modelUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  查看模型信息 ↗
                </a>
              )}
            {typeof source.originalAuthor === 'string' && (
              <p className="source-line">原作者 · {source.originalAuthor}</p>
            )}
            {typeof source.author === 'string' && (
              <p className="source-line">作者 · {source.author}</p>
            )}
            {typeof source.translationAuthor === 'string' && (
              <p className="source-line">译文作者 · {source.translationAuthor}</p>
            )}
            {typeof source.authoringMethod === 'string' && (
              <p className="source-line">编写方式 · {source.authoringMethod}</p>
            )}
            {(typeof source.sourceSentenceId === 'string' ||
              typeof source.sourceSentenceId === 'number') && (
              <p className="source-line">来源句编号 · {source.sourceSentenceId}</p>
            )}
            {typeof source.sourceUrl === 'string' && sourceLink(source.sourceUrl) && (
              <a
                className="text-link"
                href={sourceLink(source.sourceUrl)}
                target="_blank"
                rel="noopener noreferrer"
              >
                查看{label}来源 ↗
              </a>
            )}
          </div>
        );
      })}
    </>
  );
}
export function WordView({
  word,
  focusSenseId,
  onSenseChange,
  hideMeanings = false,
  interactive = true,
  presentation = 'reading',
  headerAction,
}: {
  word: Word;
  focusSenseId?: string;
  onSenseChange?: (id: string) => void;
  hideMeanings?: boolean;
  interactive?: boolean;
  presentation?: 'reading' | 'study';
  headerAction?: ReactNode;
}) {
  const available = (word.senses?.length ? word.senses : word.dictionarySenses) ?? [];
  const senses = available.filter((sense) =>
    [sense.definitionZh, sense.definitionEn].some((value) => !!dictionaryText(value)),
  );
  const sourceTranscription =
    word.pronunciationCompatible !== false &&
    (word.phonetic || word.phonetics?.find((entry) => entry.region === 'unspecified')?.text);
  return (
    <div
      className={`word-content${presentation === 'study' ? ' word-content-study' : ' word-content-reading'}`}
    >
      <div className="word-title-row">
        <div>
          <h2 className={`word-title${word.lemma.length > 20 ? ' word-title-long' : ''}`}>
            {word.lemma}
          </h2>
          {!!dictionaryText(word.dictionaryName) && (
            <span className="word-dictionary-name">{dictionaryText(word.dictionaryName)}</span>
          )}
          {!word.phoneticUs && !word.phoneticUk && !!sourceTranscription && (
            <div className="phonetic">
              <span>{sourceTranscription}</span>
            </div>
          )}
        </div>
        <AudioButton word={word} autoPlay={presentation === 'study'} />
        {headerAction && <div className="word-header-action">{headerAction}</div>}
      </div>
      {!hideMeanings && (
        <StudyWordDetails
          key={word.id}
          word={word}
          senses={senses}
          englishSenses={[]}
          interactive={interactive}
          selectedSenseId={focusSenseId}
          onSenseChange={onSenseChange}
          showDirectory={presentation === 'reading'}
        />
      )}
      {!hideMeanings &&
        presentation === 'reading' &&
        word.senses?.some((sense) => sense.kind === 'learning') && (
          <DictionaryMeanings
            key={word.id}
            senses={word.dictionarySenses ?? []}
            interactive={interactive}
          />
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
const dialogLayers: HTMLDialogElement[] = [];
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
  const active = useScreenActive();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const removeLayer = () => {
      const index = dialogLayers.indexOf(element);
      if (index >= 0) dialogLayers.splice(index, 1);
    };
    if (open && active) {
      if (!element.open) element.showModal();
      removeLayer();
      dialogLayers.push(element);
    } else if (element.open) element.close();
    const back = (event: Event) => {
      if (event.defaultPrevented || !element.open || dialogLayers.at(-1) !== element) return;
      event.preventDefault();
      close.current();
    };
    window.addEventListener(beforeAppBackEvent, back);
    return () => {
      window.removeEventListener(beforeAppBackEvent, back);
      removeLayer();
      if (element.open) element.close();
    };
  }, [open, active]);
  return (
    <dialog
      ref={ref}
      className="night-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        // The controlled owner may be saving and reject dismissal. Native cancel
        // must not silently close a dialog whose open state is still true.
        event.preventDefault();
        onClose();
      }}
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
