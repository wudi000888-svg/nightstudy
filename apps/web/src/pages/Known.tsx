import { useState } from 'react';
import { Download, Upload, ArrowRight, RotateCcw, FileCheck2 } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { download, post } from '../lib/api';
import { Empty, ErrorNotice, Heading, LoginPrompt, Notice, Panel } from '../components/UI';
interface ImportRow {
  rowNumber: number;
  input: string;
  wordId: string | null;
  lemma: string;
  match: 'matched' | 'unknown' | 'duplicate';
}
interface ImportBatch {
  id: string;
  status: 'preview' | 'confirmed' | 'revoked';
  rows: ImportRow[];
  counts: { total: number; matched: number; unknown: number; duplicate: number };
}
export function KnownPage() {
  const { user } = useApp();
  const imports = useRemote<{ items: ImportBatch[] }>(
    'known-imports',
    'known-words/imports',
    !!user,
  );
  const [format, setFormat] = useState<'text' | 'csv' | 'json'>('text');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ImportBatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  async function makePreview() {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const result = await post<{ import: ImportBatch }>('known-words/imports', { format, text });
      setPreview(result.import);
      await imports.refetch();
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  async function updateBatch(batch: ImportBatch, action: 'confirm' | 'revoke') {
    setBusy(true);
    setError(null);
    try {
      const result = await post<{ import: ImportBatch; addedCount?: number }>(
        `known-words/imports/${batch.id}/${action}`,
        {},
      );
      if (preview?.id === batch.id) setPreview(result.import);
      await imports.refetch();
      setNotice(
        action === 'confirm'
          ? '本批熟词声明已保存。它会降低重复曝光，并保留抽查。'
          : '本批声明已撤销，后续真实学习与测验记录仍保留。',
      );
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  async function exportFile(value: 'csv' | 'json') {
    setError(null);
    try {
      await download(`known-words/exports?format=${value}`, `nightstudy-known.${value}`);
    } catch (error) {
      setError(error);
    }
  }
  async function readFile(file?: File) {
    if (!file) return;
    if (file.size > 256 * 1024) {
      setError(new Error('请选择不超过 256 KB 的熟词文件。'));
      return;
    }
    try {
      setText(await file.text());
      setFormat(file.name.endsWith('.json') ? 'json' : file.name.endsWith('.csv') ? 'csv' : 'text');
      setPreview(null);
    } catch (value) {
      setError(value);
    }
  }
  if (!user)
    return (
      <div className="page">
        <LoginPrompt />
      </div>
    );
  return (
    <div className="page">
      <Heading
        eyebrow="熟词 · 有证据的一点熟悉"
        title={
          <>
            把你已认识的词，<em>带进自习室。</em>
          </>
        }
        description="导入只是自报熟悉，不伪造复习历史。熟词减少重复出现，仍然保留低频抽查。"
        action={
          <div className="action-row">
            <button className="button quiet" onClick={() => void exportFile('csv')}>
              <Download size={16} /> CSV
            </button>
            <button className="button quiet" onClick={() => void exportFile('json')}>
              <Download size={16} /> JSON
            </button>
          </div>
        }
      />
      <ErrorNotice error={error || imports.error} />
      {notice && <Notice>{notice}</Notice>}
      <div className="import-layout">
        <Panel>
          <div className="panel-title">
            <Upload size={19} />
            <h2>导入熟词</h2>
          </div>
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void makePreview();
            }}
          >
            <div className="form-columns">
              <label className="field">
                文件格式
                <select
                  value={format}
                  onChange={(event) => setFormat(event.target.value as typeof format)}
                >
                  <option value="text">纯文本 · 一行一词</option>
                  <option value="csv">CSV · lemma 列</option>
                  <option value="json">版本化 JSON</option>
                </select>
              </label>
              <label className="field">
                或读取文件
                <input
                  type="file"
                  accept=".txt,.csv,.json"
                  onChange={(event) => void readFile(event.target.files?.[0])}
                />
              </label>
            </div>
            <label className="field">
              熟词内容
              <textarea
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setPreview(null);
                }}
                rows={9}
                placeholder="rain\nquiet\nlearn"
                required
              />
            </label>
            <p className="fine-print">
              先匹配预览，再确认应用。每批1–1000行。未知词和重复行不会自动覆盖你的进度。
            </p>
            <button className="button primary" disabled={busy || !text.trim()}>
              {busy ? '正在匹配…' : '检查与匹配'}
              <ArrowRight size={16} />
            </button>
          </form>
        </Panel>
        <Panel>
          <div className="panel-title">
            <FileCheck2 size={19} />
            <h2>匹配预览</h2>
          </div>
          {preview ? (
            <>
              <div className="count-chips">
                <span>
                  总行数 <strong>{preview.counts.total}</strong>
                </span>
                <span>
                  匹配 <strong>{preview.counts.matched}</strong>
                </span>
                <span>
                  未匹配 <strong>{preview.counts.unknown}</strong>
                </span>
                <span>
                  重复 <strong>{preview.counts.duplicate}</strong>
                </span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>输入</th>
                      <th>匹配词</th>
                      <th>结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={row.rowNumber}>
                        <td>{row.input}</td>
                        <td>{row.lemma || '—'}</td>
                        <td>
                          <span className={`status-tag ${row.match}`}>
                            {row.match === 'matched'
                              ? '唯一匹配'
                              : row.match === 'duplicate'
                                ? '重复 · 不新增'
                                : '未匹配 · 不应用'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.status === 'preview' ? (
                <button
                  className="button primary"
                  disabled={busy || preview.counts.matched === 0}
                  onClick={() => void updateBatch(preview, 'confirm')}
                >
                  确认本批熟词声明 <ArrowRight size={16} />
                </button>
              ) : (
                <Notice>
                  {preview.status === 'confirmed'
                    ? '本批已经应用。状态为自报熟词，尚未客观确认。'
                    : '本批声明已撤销。'}
                </Notice>
              )}
            </>
          ) : (
            <Empty
              title="预览会出现在这里。"
              description="确认前不会改变熟悉度、计划或已保存的复习状态。"
            />
          )}
        </Panel>
      </div>
      <Panel className="batch-panel">
        <div className="section-heading">
          <h2>导入批次</h2>
          <span className="tiny-label">撤销声明，保留后来的学习</span>
        </div>
        {imports.data?.items.length ? (
          <div className="batch-list">
            {imports.data.items.map((batch, index) => (
              <article key={batch.id}>
                <span className="batch-icon">
                  <FileCheck2 size={20} />
                </span>
                <div>
                  <strong>熟词批次 {imports.data.items.length - index}</strong>
                  <small>
                    {batch.counts.matched} 词匹配 ·{' '}
                    {batch.status === 'confirmed'
                      ? '已应用 · 自报熟词'
                      : batch.status === 'revoked'
                        ? '已撤销'
                        : '待确认'}
                  </small>
                </div>
                <div className="row-actions">
                  <button className="button quiet" onClick={() => setPreview(batch)}>
                    查看
                  </button>
                  {batch.status === 'confirmed' && (
                    <button
                      className="button quiet"
                      disabled={busy}
                      onClick={() => void updateBatch(batch, 'revoke')}
                    >
                      <RotateCcw size={14} /> 撤销
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">还没有导入批次。可以从你已认识的一小组词开始。</p>
        )}
      </Panel>
    </div>
  );
}
