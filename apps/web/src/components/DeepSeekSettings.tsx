import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Copy, KeyRound, Search, Save, Sparkles, Trash2, Unplug } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { api, ApiError, post } from '../lib/api';
import { adminWordEditorUrl } from '../lib/admin-word-editor';
import type { Word } from '../lib/types';
import { AdminConfirm, type AdminConfirmation } from './AdminConfirm';
import { Empty, ErrorNotice, Loading, Notice, Panel } from './UI';

export interface DeepSeekConfig {
  enabled: boolean;
  configured: boolean;
  model: string;
  models: string[];
  baseUrl: string;
  keyPreview: string | null;
  updatedAt: string | null;
}
interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
export interface DeepSeekCandidate {
  preview: {
    wordId: string;
    lemma: string;
    definitions: {
      sourceSenseId: string;
      field: 'definitionEn' | 'definitionZh';
      sourceTextSha256: string;
      sourceText: string;
      sourceField: 'definitionZh' | 'definitionEn';
      sourceLanguage: 'zh' | 'en';
      value: string;
      contentMetadata: Record<string, unknown>;
    }[];
    examples: {
      sourceSenseId: string;
      sourceTextSha256: string;
      sourceText: string;
      sourceField: 'definitionZh' | 'definitionEn';
      sourceLanguage: 'zh' | 'en';
      exampleEn: string;
      exampleZh: string;
      contentMetadata: Record<string, unknown>;
    }[];
    review: 'pending';
    applied: false;
    reason?: 'no_missing_content';
  };
  usage: Usage | null;
}
interface Resolution {
  word: Word | null;
  queried: string;
  matchedLemma: string | null;
  matchType: 'exact' | 'inflection' | 'not-found';
}
const path = 'admin/ai/deepseek';
const modelNames: Record<string, string> = {
  'deepseek-flash': 'DeepSeek Flash',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
};
function UsageNotice({ usage }: { usage: Usage | null }) {
  if (!usage) return null;
  return (
    <p className="fine-print">
      本次用量：输入 {usage.promptTokens} · 输出 {usage.completionTokens} · 合计 {usage.totalTokens}{' '}
      tokens
    </p>
  );
}

export function DeepSeekPreview({
  candidate,
  word,
  onCopy,
}: {
  candidate: DeepSeekCandidate;
  word: Word;
  onCopy: () => void;
}) {
  const { preview } = candidate;
  if (preview.wordId !== word.id)
    return <ErrorNotice error={new Error('候选与当前选择的词不一致，请重新预览。')} />;
  return (
    <Panel className="admin-management-wide">
      <div className="section-heading">
        <div>
          <h2>{preview.lemma} · 补全候选</h2>
          <p className="fine-print">待校对 · 尚未保存到词库</p>
        </div>
        <button type="button" className="button ghost" onClick={onCopy}>
          <Copy size={15} /> 复制候选
        </button>
      </div>
      <p className="fine-print">
        请逐项核对词义与中英对应。每条释义可打开对应原始义项手动编辑；预览不会自动覆盖现有内容。
      </p>
      {preview.definitions.length === 0 && preview.examples.length === 0 ? (
        <Empty title="这个词暂无需要补全的内容。" description="没有生成候选，也没有改动词库。" />
      ) : (
        <div className="management-list">
          {preview.definitions.map((definition) => (
            <article
              className="management-card"
              key={`${definition.sourceSenseId}:${definition.field}`}
            >
              <strong>
                {definition.field === 'definitionEn' ? '英文释义候选' : '中文释义候选'}
              </strong>
              <p className="fine-print">本次请求的原义</p>
              <p lang={definition.sourceLanguage === 'en' ? 'en' : 'zh-CN'}>
                {definition.sourceText}
              </p>
              <p lang={definition.field === 'definitionEn' ? 'en' : 'zh-CN'}>{definition.value}</p>
              <Link
                className="button quiet"
                to={adminWordEditorUrl({
                  wordId: preview.wordId,
                  senseId: definition.sourceSenseId,
                  sourceField: definition.sourceField,
                  sourceHash: definition.sourceTextSha256,
                })}
              >
                校对这个义项
              </Link>
            </article>
          ))}
          {preview.examples.map((example, index) => (
            <article className="management-card" key={`${example.sourceSenseId}:${index}`}>
              <strong>例句候选</strong>
              <p className="fine-print">生成依据的原义</p>
              <p lang={example.sourceLanguage === 'en' ? 'en' : 'zh-CN'}>{example.sourceText}</p>
              <p lang="en">{example.exampleEn}</p>
              <p lang="zh-CN">{example.exampleZh}</p>
              <p className="fine-print">
                这条词级用法候选尚未写入。当前内容编辑器只保存所选义项的例句；请确认适用于该义项后再手工填写，不会自动绑定。
              </p>
              <Link
                className="button quiet"
                to={adminWordEditorUrl({
                  wordId: preview.wordId,
                  senseId: example.sourceSenseId,
                  sourceField: example.sourceField,
                  sourceHash: example.sourceTextSha256,
                })}
              >
                核对生成依据的义项
              </Link>
            </article>
          ))}
        </div>
      )}
      <UsageNotice usage={candidate.usage} />
      <Link className="button quiet" to="/admin/content">
        前往内容管理校对
      </Link>
    </Panel>
  );
}

export function DeepSeekSettings() {
  const { scope, user } = useApp();
  if (user?.role !== 'admin') return null;
  // Switching accounts immediately drops the private draft key and all candidates.
  return <DeepSeekSettingsContent key={scope} />;
}

function DeepSeekSettingsContent() {
  const { scope } = useApp();
  const client = useQueryClient();
  const remote = useRemote<DeepSeekConfig>('admin-deepseek', path);
  const [draft, setDraft] = useState<{ enabled: boolean; model: string } | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<AdminConfirmation | null>(null);
  const [search, setSearch] = useState('');
  const [word, setWord] = useState<Word | null>(null);
  const [lookupDone, setLookupDone] = useState(false);
  const [candidate, setCandidate] = useState<DeepSeekCandidate | null>(null);
  const [tested, setTested] = useState<{ model: string; usage: Usage | null } | null>(null);
  const active = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const config = remote.data;
  const form = draft ?? config;
  const dirty =
    Boolean(apiKey.trim()) ||
    Boolean(config && form && (form.enabled !== config.enabled || form.model !== config.model));
  const canRequest = Boolean(config?.enabled && config.configured && !dirty && !busy);

  async function perform(action: string, run: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(action);
    setError(null);
    setNotice('');
    try {
      await run();
    } catch (value) {
      if (active.current)
        setError(value instanceof ApiError ? value : new Error('这次操作未完成，请手动重试。'));
    } finally {
      running.current = false;
      if (active.current) setBusy(null);
    }
  }
  function acceptConfig(value: DeepSeekConfig) {
    if (!active.current) return;
    client.setQueryData([scope, 'admin-deepseek', path], value);
    setDraft(null);
    setApiKey('');
    setTested(null);
    setCandidate(null);
  }
  async function save() {
    if (!form || busy) return;
    await perform('save', async () => {
      const value = await post<DeepSeekConfig>(
        path,
        {
          enabled: form.enabled,
          model: form.model,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
        'PUT',
      );
      acceptConfig(value);
      if (active.current) setNotice('设置已保存。密钥输入框已清空。');
    });
  }
  async function removeKey() {
    await perform('remove', async () => {
      const value = await post<DeepSeekConfig>(path, { removeKey: true }, 'PUT');
      acceptConfig(value);
      if (active.current) setNotice('密钥已删除，DeepSeek 已关闭。');
    });
  }
  async function test() {
    if (!canRequest) return;
    setTested(null);
    await perform('test', async () => {
      const result = await post<{
        ok: true;
        provider: 'deepseek';
        model: string;
        usage: Usage | null;
      }>(`${path}/test`, {});
      if (active.current) {
        setTested(result);
        setNotice('连接检测通过。');
      }
    });
  }
  async function resolve() {
    const text = search.trim();
    if (!text || busy) return;
    setWord(null);
    setCandidate(null);
    setLookupDone(false);
    await perform('lookup', async () => {
      const result = await api<Resolution>(`dictionary/resolve?text=${encodeURIComponent(text)}`);
      if (!active.current) return;
      setWord(result.matchType === 'exact' ? result.word : null);
      setLookupDone(true);
    });
  }
  async function preview() {
    if (!word || !canRequest) return;
    setCandidate(null);
    await perform('preview', async () => {
      const result = await post<DeepSeekCandidate>(`${path}/preview`, { wordId: word.id });
      if (result.preview.wordId !== word.id)
        throw new ApiError(502, '候选与当前选择的词不一致，请重新预览。');
      if (active.current) setCandidate(result);
    });
  }
  async function copy() {
    if (!candidate) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(candidate.preview, null, 2));
      if (active.current) setNotice('候选已复制，尚未保存到词库。');
    } catch {
      if (active.current) setNotice('浏览器未允许复制，请在下方展开候选文本后手动复制。');
    }
  }
  return (
    <div className="admin-management-grid">
      <Panel>
        <div className="panel-title">
          <KeyRound size={18} />
          <h2>DeepSeek 设置</h2>
        </div>
        <p className="fine-print">仅管理员可配置。检测和预览需主动点击，会使用少量 API 额度。</p>
        {remote.isPending && <Loading text="正在读取 AI 配置…" />}
        <ErrorNotice error={remote.error} onRetry={() => void remote.refetch()} />
        {config && form && (
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="field">
              服务状态
              <select
                value={form.enabled ? 'enabled' : 'disabled'}
                disabled={!!busy}
                onChange={(event) => {
                  setDraft({ enabled: event.target.value === 'enabled', model: form.model });
                  setTested(null);
                  setCandidate(null);
                }}
              >
                <option value="disabled">关闭</option>
                <option value="enabled">启用</option>
              </select>
            </label>
            <label className="field">
              模型
              <select
                value={form.model}
                disabled={!!busy}
                onChange={(event) => {
                  setDraft({ enabled: form.enabled, model: event.target.value });
                  setTested(null);
                  setCandidate(null);
                }}
              >
                {config.models.map((model) => (
                  <option key={model} value={model}>
                    {modelNames[model] ?? model}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              API 密钥
              <input
                type="password"
                name="deepseek-api-key"
                autoComplete="off"
                value={apiKey}
                maxLength={256}
                disabled={!!busy}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setTested(null);
                  setCandidate(null);
                }}
                placeholder={config.configured ? '留空保留已保存的密钥' : '输入新的 API 密钥'}
              />
              <small className="fine-print">
                {config.configured
                  ? `已保存密钥${config.keyPreview ? ` · 尾号 ${config.keyPreview.slice(-4)}` : ''}`
                  : '尚未保存密钥'}
              </small>
            </label>
            <div className="action-row">
              <button type="submit" className="button primary" disabled={!!busy}>
                <Save size={15} /> {busy === 'save' ? '正在保存…' : '保存设置'}
              </button>
              <button
                type="button"
                className="button quiet"
                disabled={!!busy || !config.configured}
                onClick={() =>
                  setConfirmation({
                    title: '删除本站 DeepSeek 密钥？',
                    message: '已保存的密钥将被删除，AI 服务会同时关闭。再次使用需要重新输入密钥。',
                    label: '删除密钥并关闭',
                    run: removeKey,
                  })
                }
              >
                <Trash2 size={15} /> 删除密钥
              </button>
            </div>
            <p className="fine-print">服务地址：{config.baseUrl}</p>
          </form>
        )}
      </Panel>
      <Panel>
        <h2>手动检测与补全</h2>
        <p className="fine-print">先保存配置，再检测连接或为一个准确匹配的词生成缺口候选。</p>
        <button type="button" className="button ghost" disabled={!canRequest} onClick={test}>
          <Unplug size={15} /> {busy === 'test' ? '正在检测…' : '检测连接'}
        </button>
        {tested && (
          <div className="management-card">
            <strong>{modelNames[tested.model] ?? tested.model} · 连接通过</strong>
            <UsageNotice usage={tested.usage} />
          </div>
        )}
        {dirty && <p className="fine-print">有未保存的配置，请先保存后再检测或预览。</p>}
        {!config?.enabled && !remote.isPending && <p className="fine-print">当前服务未启用。</p>}
        <form
          className="form-stack management-list"
          onSubmit={(event) => {
            event.preventDefault();
            void resolve();
          }}
        >
          <label className="field">
            选择待补全的单词或词组
            <input
              value={search}
              maxLength={160}
              required
              disabled={!!busy}
              onChange={(event) => {
                setSearch(event.target.value);
                setWord(null);
                setCandidate(null);
                setLookupDone(false);
              }}
              placeholder="输入完整词形，精确查找"
            />
          </label>
          <button className="button ghost" disabled={!!busy || !search.trim()}>
            <Search size={15} /> {busy === 'lookup' ? '正在查找…' : '精确查词'}
          </button>
        </form>
        {lookupDone && !word && (
          <p role="status" className="fine-print">
            没有找到准确匹配的已发布词条，请核对完整词形。
          </p>
        )}
        {word && (
          <div className="management-card management-list">
            <strong>{word.lemma}</strong>
            <p>
              {word.senses?.find((sense) => sense.definitionZh?.trim())?.definitionZh ||
                word.senses?.find((sense) => sense.definitionEn?.trim())?.definitionEn ||
                '暂无可显示的释义'}
            </p>
            <button
              type="button"
              className="button primary"
              disabled={!canRequest}
              onClick={preview}
            >
              <Sparkles size={15} /> {busy === 'preview' ? '正在生成候选…' : '生成补全预览'}
            </button>
            <small className="fine-print">此操作会使用 API 额度，结果需人工校对，尚未保存。</small>
          </div>
        )}
      </Panel>
      <div className="admin-management-wide" aria-live="polite">
        {busy && <Loading text={busy === 'preview' ? '正在等待补全候选…' : '正在处理…'} />}
        <ErrorNotice error={error} />
        {notice && <Notice>{notice}</Notice>}
      </div>
      {candidate && word && (
        <>
          <DeepSeekPreview candidate={candidate} word={word} onCopy={() => void copy()} />
          <Panel className="admin-management-wide">
            <details>
              <summary>展开候选文本与来源记录</summary>
              <label className="field">
                可手动复制的候选 JSON
                <textarea readOnly rows={8} value={JSON.stringify(candidate.preview, null, 2)} />
              </label>
            </details>
          </Panel>
        </>
      )}
      <AdminConfirm action={confirmation} onClose={() => setConfirmation(null)} />
    </div>
  );
}
