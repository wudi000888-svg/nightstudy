import { useState } from 'react';
import { ArrowRightLeft, ExternalLink, Languages } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useApp, useRemote } from '../AppContext';
import { post } from '../lib/api';
import { ErrorNotice, Heading, Loading, Notice, Panel } from './UI';

type SourceLanguage = 'auto' | 'en' | 'zh-CN';
type TargetLanguage = 'en' | 'zh-CN';
interface Provider {
  id: 'google';
  mode: 'website-official' | 'integrated';
  transport: null | 'direct' | 'gateway';
  configured: boolean;
  unofficial: boolean;
  bestEffort: boolean;
  iframeSupported: false;
  maxTextLength: number;
  websiteUrl: string;
  retainsTranslationHistory: false;
}
interface Translation {
  text: string;
  translatedText: string;
  sourceLanguage: SourceLanguage;
  targetLanguage: TargetLanguage;
  detectedSourceLanguage: string | null;
  provider: 'google-web-compat';
  unofficial: true;
  bestEffort: true;
  transport: 'direct' | 'gateway';
  translatedAt: string;
}
interface Website {
  provider: 'google';
  mode: 'external';
  url: string;
  iframeSupported: false;
}
function googleUrl(text: string, source: SourceLanguage, target: TargetLanguage) {
  const url = new URL('https://translate.google.com/');
  url.search = new URLSearchParams({ sl: source, tl: target, text, op: 'translate' }).toString();
  return url.toString();
}
function officialUrl(value: string) {
  const parsed = new URL(value);
  if (parsed.origin !== 'https://translate.google.com') throw new Error('翻译网页入口暂时不可用。');
  return parsed.toString();
}

export function TranslationPanel({ initialText = '' }: { initialText?: string }) {
  const { user } = useApp();
  const provider = useRemote<{ provider: Provider }>(
    'translation-provider',
    'translation/provider',
  );
  const [text, setText] = useState(initialText);
  const [source, setSource] = useState<SourceLanguage>('en');
  const [target, setTarget] = useState<TargetLanguage>('zh-CN');
  const [translation, setTranslation] = useState<Translation | null>(null);
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const limit = provider.data?.provider.maxTextLength ?? 1000;
  const integrated =
    !!provider.data?.provider.configured && provider.data.provider.mode === 'integrated';
  const input = { text: text.trim(), sourceLanguage: source, targetLanguage: target };
  const externalUrl = website || googleUrl(text, source, target);

  function clearResult() {
    setTranslation(null);
    setWebsite('');
    setNotice('');
    setError(null);
  }
  async function translate() {
    if (!input.text || busy) return;
    setBusy(true);
    clearResult();
    try {
      if (integrated && user) {
        const result = await post<{ translation: Translation; website: Website }>(
          'translation/text',
          input,
        );
        setTranslation(result.translation);
        setWebsite(officialUrl(result.website.url));
      } else {
        const result = await post<Website>('translation/website', input);
        setWebsite(officialUrl(result.url));
        setNotice('Google官方网页入口已准备好，点击下方按钮打开。');
      }
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="translation-workspace">
      <Panel className="translation-input-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">网页翻译 · 把一句话读清楚</span>
            <h2>让语境，也有一个入口。</h2>
          </div>
          <Languages size={22} />
        </div>
        {provider.isPending && <Loading text="正在检查本站翻译服务…" />}
        <ErrorNotice error={provider.error} onRetry={() => void provider.refetch()} />
        <div className="translation-languages">
          <label className="field">
            原文语言
            <select
              value={source}
              disabled={busy}
              onChange={(event) => {
                clearResult();
                setSource(event.target.value as SourceLanguage);
              }}
            >
              <option value="auto">自动检测</option>
              <option value="en">英语</option>
              <option value="zh-CN">简体中文</option>
            </select>
          </label>
          <button
            className="icon-button"
            aria-label="交换翻译语言"
            disabled={busy}
            onClick={() => {
              clearResult();
              setSource(target);
              setTarget(source === 'zh-CN' ? 'zh-CN' : 'en');
            }}
          >
            <ArrowRightLeft size={18} />
          </button>
          <label className="field">
            译文语言
            <select
              value={target}
              disabled={busy}
              onChange={(event) => {
                clearResult();
                setTarget(event.target.value as TargetLanguage);
              }}
            >
              <option value="zh-CN">简体中文</option>
              <option value="en">英语</option>
            </select>
          </label>
        </div>
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void translate();
          }}
        >
          <label className="field">
            想读懂的原文
            <textarea
              value={text}
              onChange={(event) => {
                clearResult();
                setText(event.target.value);
              }}
              rows={7}
              maxLength={limit}
              disabled={busy}
              placeholder="粘贴一段英文，或输入想翻译的中文…"
            />
          </label>
          <div className="translation-actions">
            <span className="fine-print">
              {text.length} / {limit} 字符
            </span>
            <button
              className="button primary"
              disabled={busy || provider.isPending || !text.trim()}
              type="submit"
            >
              {busy ? '正在获取…' : integrated && user ? '翻译这段文字' : '准备Google网页入口'}
              <Languages size={17} />
            </button>
          </div>
        </form>
        {!user && integrated && (
          <Notice>
            登录后可在本站获取译文，也可直接使用Google官方网页。<Link to="/auth">连接学习账户</Link>
          </Notice>
        )}
        {provider.data && !integrated && (
          <Notice>本站暂未启用站内翻译，可使用Google官方网页。</Notice>
        )}
        <ErrorNotice error={error} onRetry={() => void translate()} />
        {notice && <Notice>{notice}</Notice>}
        <a className="button ghost" href={externalUrl} target="_blank" rel="noopener noreferrer">
          在Google官方网页打开 <ExternalLink size={16} />
        </a>
      </Panel>
      <Panel className="translation-result-panel">
        <span className="eyebrow">译文 · 来自当前请求</span>
        <h2>{translation ? '再把这句话读一次。' : '译文会出现在这里。'}</h2>
        {translation ? (
          <>
            <p className="translation-text">{translation.translatedText}</p>
            <div className="translation-provenance">
              <span className="soft-badge">Google翻译 · 网页接口</span>
              <p>
                {translation.transport === 'gateway'
                  ? '本次译文由本站翻译网关获取。'
                  : '本次译文由本站获取。'}
              </p>
              <p>非官方接入，可用性取决于Google网页服务。译文供理解语境时参考。</p>
              {translation.detectedSourceLanguage && (
                <p>检测到的原文语言：{translation.detectedSourceLanguage}</p>
              )}
            </div>
          </>
        ) : (
          <p className="muted-copy">
            {busy
              ? '正在等待翻译服务返回结果…'
              : '输入原文后获取译文。若本站服务暂时不可用，可打开官方翻译网页。'}
          </p>
        )}
      </Panel>
    </div>
  );
}

export function TranslationPage() {
  return (
    <div className="page">
      <Heading
        eyebrow="网页翻译 · 连接语境"
        title={
          <>
            让一句话，<em>慢慢读懂。</em>
          </>
        }
        description="在本站获取Google网页翻译结果，也可继续到Google官方网页。"
      />
      <TranslationPanel />
    </div>
  );
}
