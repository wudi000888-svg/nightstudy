import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Upload, ArrowRight, RotateCcw, FileCheck2, CheckCheck } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { useScreenActive } from '../lib/screen-lifecycle';
import { api, download, post } from '../lib/api';
import { dictionaryText } from '../lib/dictionary';
import type { PageInfo, Progress, Word } from '../lib/types';
import { Empty, ErrorNotice, Heading, Loading, LoginPrompt, Notice, Panel } from '../components/UI';
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
export interface KnownWord {
  wordId: string;
  word: Word;
  origin: 'manual' | 'automatic';
  knownAt: string;
  progress: Progress | null;
}
export function KnownWordList({ items }: { items: KnownWord[] }) {
  return (
    <div className="batch-list">
      {items.map((item) => {
        const meaning = item.word.senses?.find((sense) => dictionaryText(sense.definitionZh));
        const description =
          dictionaryText(meaning?.definitionZh) ||
          dictionaryText(
            item.word.senses?.find((sense) => dictionaryText(sense.definitionEn))?.definitionEn,
          );
        return (
          <article key={item.wordId}>
            <div>
              <strong lang="en">
                <Link to={`/lookup?q=${encodeURIComponent(item.word.lemma)}`}>
                  {item.word.lemma}
                </Link>
              </strong>
              {description && <small>{description}</small>}
            </div>
            <span className="soft-badge">
              {item.origin === 'manual' ? '自己标记' : '复习后熟悉'}
            </span>
          </article>
        );
      })}
    </div>
  );
}
export function KnownPage() {
  const { scope } = useApp();
  return <KnownContent key={scope} />;
}
function KnownContent() {
  const { user, scope } = useApp();
  const active = useScreenActive();
  const foreground = useRef(active);
  foreground.current = active;
  const client = useQueryClient();
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [tab, setTab] = useState<'list' | 'import'>('list');
  const imports = useRemote<{ items: ImportBatch[] }>(
    'known-imports',
    'known-words/imports',
    !!user && tab === 'import',
  );
  const known = useInfiniteQuery({
    queryKey: [scope, 'known-words', 'pages'],
    queryFn: ({ pageParam, signal }) =>
      api<{ items: KnownWord[]; page: PageInfo }>(
        `known-words?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) =>
      last.page.hasMore ? (last.page.nextCursor ?? undefined) : undefined,
    enabled: !!user && active && tab === 'list',
    retry: false,
  });
  const knownItems = useMemo(
    () => [
      ...new Map(
        (known.data?.pages.flatMap((batch) => batch.items) ?? []).map((item) => [
          item.wordId,
          item,
        ]),
      ).values(),
    ],
    [known.data],
  );
  const knownTotal = known.data?.pages[0]?.page.total;
  const [format, setFormat] = useState<'text' | 'csv' | 'json'>('text');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ImportBatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    setTab('list');
    setFormat('text');
    setText('');
    setPreview(null);
    setBusy(false);
    setError(null);
    setNotice('');
  }, [scope]);
  async function makePreview() {
    const owner = scope;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const result = await post<{ import: ImportBatch }>('known-words/imports', { format, text });
      if (currentScope.current !== owner) return;
      setPreview(result.import);
      if (foreground.current) await imports.refetch();
    } catch (value) {
      if (currentScope.current === owner) setError(value);
    } finally {
      if (currentScope.current === owner) setBusy(false);
    }
  }
  async function updateBatch(batch: ImportBatch, action: 'confirm' | 'revoke') {
    const owner = scope;
    setBusy(true);
    setError(null);
    try {
      const result = await post<{ import: ImportBatch; addedCount?: number }>(
        `known-words/imports/${batch.id}/${action}`,
        {},
      );
      if (currentScope.current !== owner) return;
      if (preview?.id === batch.id) setPreview(result.import);
      await Promise.all([
        ...(foreground.current ? [imports.refetch()] : []),
        client.invalidateQueries({ queryKey: [owner, 'known-words'] }),
        client.invalidateQueries({ queryKey: [owner, 'books'] }),
        client.invalidateQueries({ queryKey: [owner, 'plan'] }),
        client.invalidateQueries({ queryKey: [owner, 'app-home'] }),
      ]);
      if (currentScope.current !== owner) return;
      setNotice(
        action === 'confirm'
          ? '这批熟词已保存，以后会少出现一些，仍保留偶尔抽查。'
          : '这批熟词标记已撤销，已有学习和测验记录仍保留。',
      );
    } catch (value) {
      if (currentScope.current === owner) setError(value);
    } finally {
      if (currentScope.current === owner) setBusy(false);
    }
  }
  async function exportFile(value: 'csv' | 'json') {
    const owner = scope;
    setError(null);
    try {
      await download(`known-words/exports?format=${value}`, `nightstudy-known.${value}`);
    } catch (error) {
      if (currentScope.current === owner) setError(error);
    }
  }
  async function readFile(file?: File) {
    const owner = scope;
    if (!file) return;
    if (file.size > 256 * 1024) {
      setError(new Error('请选择不超过 256 KB 的熟词文件。'));
      return;
    }
    try {
      const content = await file.text();
      if (currentScope.current !== owner) return;
      setText(content);
      const filename = file.name.toLowerCase();
      setFormat(filename.endsWith('.json') ? 'json' : filename.endsWith('.csv') ? 'csv' : 'text');
      setPreview(null);
    } catch (value) {
      if (currentScope.current === owner) setError(value);
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
        eyebrow="熟词 · 给已熟悉的词留一点空间"
        title={
          <>
            把你已认识的词，<em>带进自习室。</em>
          </>
        }
        description="熟悉的词少出现，仍会偶尔抽查。查看学习后熟悉的词，也可以导入自己已经认识的词。"
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
      <div className="tab-row">
        <button
          className={tab === 'list' ? 'active' : ''}
          aria-pressed={tab === 'list'}
          onClick={() => setTab('list')}
        >
          <CheckCheck size={16} /> 我的熟词
        </button>
        <button
          className={tab === 'import' ? 'active' : ''}
          aria-pressed={tab === 'import'}
          onClick={() => setTab('import')}
        >
          <Upload size={16} /> 导入与批次
        </button>
      </div>
      <ErrorNotice
        error={error || (tab === 'list' ? known.error : imports.error)}
        onRetry={() => {
          if (tab === 'list') void known.refetch();
          else void imports.refetch();
        }}
      />
      {notice && <Notice>{notice}</Notice>}
      {tab === 'list' ? (
        <Panel className="batch-panel">
          <div className="section-heading">
            <h2>我的熟词</h2>
            {knownTotal !== undefined && (
              <span className="tiny-label">
                已显示 {knownItems.length} / {knownTotal} 词
              </span>
            )}
          </div>
          <p className="content-caption">
            “自己标记”来自你的导入；“复习后熟悉”来自多次复习。同一个词只显示一次。
          </p>
          {known.isPending ? (
            <Loading text="正在打开熟词…" />
          ) : knownItems.length ? (
            <>
              <KnownWordList items={knownItems} />
              {known.hasNextPage && (
                <button
                  className="button ghost"
                  disabled={known.isFetchingNextPage}
                  onClick={() => {
                    if (active) void known.fetchNextPage();
                  }}
                >
                  {known.isFetchingNextPage ? '正在读取…' : '更多熟词'} <ArrowRight size={16} />
                </button>
              )}
            </>
          ) : !known.error ? (
            <Empty
              title="熟词会慢慢积累在这里。"
              description="继续学习和复习，或导入你已经认识的词。"
              action={
                <button className="button ghost" onClick={() => setTab('import')}>
                  导入熟词 <ArrowRight size={16} />
                </button>
              }
            />
          ) : null}
        </Panel>
      ) : (
        <>
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
                      <option value="csv">CSV 表格 · lemma 列</option>
                      <option value="json">JSON 备份文件</option>
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
                  先预览，再确认。每批1–1000行；未匹配和重复的词不会加入。
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
                      保存这批熟词 <ArrowRight size={16} />
                    </button>
                  ) : (
                    <Notice>
                      {preview.status === 'confirmed'
                        ? '这批熟词已保存为你的标记。'
                        : '这批熟词标记已撤销。'}
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
              <span className="tiny-label">撤销标记，保留学习记录</span>
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
                          ? '已保存 · 自己标记'
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
        </>
      )}
    </div>
  );
}
