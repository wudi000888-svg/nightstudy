import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, Download, FileUp, Pencil, Plus, Archive, ArrowRight } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { api, download, newId, post } from '../lib/api';
import {
  goalLabels,
  goalNames,
  type Book,
  type BookFileFormat,
  type CustomBookPreview,
  type CustomBookTemplate,
  type Goal,
} from '../lib/types';
import {
  Dialog,
  Empty,
  ErrorNotice,
  Heading,
  Loading,
  LoginPrompt,
  Notice,
  Panel,
} from '../components/UI';
import { AdminConfirm, type AdminConfirmation } from '../components/AdminConfirm';
import { adminTime } from '../components/AdminTools';

function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result ?? '');
      const comma = data.indexOf(',');
      if (comma < 0) reject(new Error('文件读取失败，请重新选择。'));
      else resolve(data.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error('文件读取失败，请重新选择。'));
    reader.readAsDataURL(file);
  });
}
const previewLabels = { all: '全部行', ready: '合格', failed: '失败', duplicate: '重复' } as const;

export function CustomBookImportPage() {
  const { user, scope } = useApp();
  const client = useQueryClient();
  const template = useRemote<CustomBookTemplate>(
    'custom-book-template',
    'custom-books/template',
    !!user,
  );
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [goal, setGoal] = useState<Goal>('daily');
  const [preview, setPreview] = useState<CustomBookPreview | null>(null);
  const [filter, setFilter] = useState<keyof typeof previewLabels>('all');
  const [cursor, setCursor] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<AdminConfirmation | null>(null);
  const generation = useRef(0);
  const confirmCommand = useRef<{ importId: string; commandId: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    generation.current++;
    setFile(null);
    setPreview(null);
    setTitle('');
    setDescription('');
    setError(null);
    setNotice('');
    setBusy('');
    setConfirmation(null);
    confirmCommand.current = null;
    if (fileInput.current) fileInput.current.value = '';
  }, [scope]);
  async function upload() {
    if (!file || !user) return;
    const requestId = generation.current;
    setError(null);
    setNotice('');
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!['txt', 'pdf', 'docx'].includes(extension ?? '')) {
      setError(new Error('仅支持 .txt、.pdf 和 .docx；旧版 .doc 请先另存为 .docx。'));
      return;
    }
    const format = extension as BookFileFormat;
    const maximum =
      format === 'txt'
        ? (template.data?.limits.maxTxtBytes ?? 262144)
        : (template.data?.limits.maxFileBytes ?? 2097152);
    if (!file.size || file.size > maximum) {
      setError(
        new Error(
          format === 'txt'
            ? 'TXT文件需大于0且不超过256 KiB。'
            : 'PDF或DOCX文件需大于0且不超过2 MiB。',
        ),
      );
      return;
    }
    setBusy('upload');
    try {
      const contentBase64 = await fileBase64(file);
      if (generation.current !== requestId) return;
      const result = await post<CustomBookPreview>('custom-books/imports', {
        title,
        description,
        goal,
        format,
        filename: file.name,
        contentBase64,
      });
      if (generation.current !== requestId) return;
      setPreview(result);
      setFilter('all');
      setCursor('');
      confirmCommand.current = { importId: result.import.id, commandId: newId() };
      setNotice('预览已生成。请查看合格、失败和重复项，确认后才会创建私有词书。');
    } catch (value) {
      if (generation.current === requestId) setError(value);
    } finally {
      if (generation.current === requestId) setBusy('');
    }
  }
  async function loadPage(nextCursor = '', nextFilter = filter) {
    if (!preview) return;
    const requestId = generation.current;
    setBusy('page');
    setError(null);
    try {
      const value = await api<CustomBookPreview>(
        `custom-books/imports/${encodeURIComponent(preview.import.id)}?limit=100&status=${nextFilter}${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ''}`,
      );
      if (generation.current === requestId) {
        setPreview(value);
        setCursor(nextCursor);
        setFilter(nextFilter);
      }
    } catch (value) {
      if (generation.current === requestId) setError(value);
    } finally {
      if (generation.current === requestId) setBusy('');
    }
  }
  async function confirm() {
    if (!preview) return;
    const requestId = generation.current;
    const importId = preview.import.id;
    if (confirmCommand.current?.importId !== importId)
      confirmCommand.current = { importId, commandId: newId() };
    setBusy('confirm');
    setError(null);
    try {
      const result = await post<{
        book: Book;
        import: CustomBookPreview['import'];
        addedCount: number;
        skippedCount: number;
      }>(`custom-books/imports/${encodeURIComponent(importId)}/confirm`, {
        commandId: confirmCommand.current.commandId,
      });
      if (generation.current !== requestId) return;
      setPreview((current) => (current ? { ...current, import: result.import } : current));
      setNotice(`私有词书已创建：${result.addedCount} 个合格词，${result.skippedCount} 项未加入。`);
      await client.invalidateQueries({ queryKey: [scope] });
    } catch (value) {
      if (generation.current === requestId) {
        await loadPage('', filter);
        if (generation.current === requestId) setError(value);
      }
    } finally {
      if (generation.current === requestId) setBusy('');
    }
  }
  async function exportFile(path: string, name: string) {
    setError(null);
    try {
      await download(path, name);
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
  const expired = !!preview && Date.parse(preview.import.expiresAt) <= Date.now();
  return (
    <div className="page custom-book-page">
      <Heading
        eyebrow="我的词书 · 标准文档导入"
        title={
          <>
            把想学的词，<em>整理成自己的书。</em>
          </>
        }
        description="文件与生成的词书只属于本站当前账户。仅将词典已收录、中文释义与英美音标音源就绪的合格词加入。"
        action={
          <Link className="button ghost" to="/books/mine">
            我的词书 <ArrowRight size={16} />
          </Link>
        }
      />
      <ErrorNotice error={error} />
      {notice && <Notice>{notice}</Notice>}
      <div className="custom-import-layout">
        <Panel>
          <h2>1. 使用标准模板</h2>
          <p>
            首个非空行固定为 <code>NIGHTSTUDY-WORDBOOK v1</code>
            ，之后每行一个英语单词或短语，不添加编号、表格或释义。
          </p>
          <p className="fine-print">
            TXT使用UTF-8，最大256 KiB；PDF/DOCX最大2 MiB、PDF最多
            {template.data?.limits.maxPages ?? 250}页；每份最多
            {(template.data?.limits.maxEntries ?? 10000).toLocaleString('zh-CN')}
            项。扫描图片PDF不做OCR，旧版DOC、加密或损坏文档不支持。
          </p>
          <ErrorNotice error={template.error} />
          <div className="action-row">
            {(['txt', 'docx', 'pdf'] as const).map((format) => (
              <button
                key={format}
                className="button ghost"
                disabled={!!busy}
                onClick={() =>
                  void exportFile(`custom-books/templates/${format}`, `夜读英语-词书模板.${format}`)
                }
              >
                <Download size={15} />
                {format.toUpperCase()}模板
              </button>
            ))}
          </div>
          {template.data && <pre className="book-template-preview">{template.data.text}</pre>}
          <p className="fine-print">
            缺失英美IPA、任一英美音频或中文释义会列为失败。合成音源会明确标记，合成声不会被称为真人录音。补齐资料后请重新上传生成预览。
          </p>
        </Panel>
        <Panel>
          <h2>2. 上传并生成预览</h2>
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void upload();
            }}
          >
            <label className="field">
              私有词书标题
              <input
                required
                maxLength={160}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="field">
              学习目标
              <select value={goal} onChange={(event) => setGoal(event.target.value as Goal)}>
                {goalNames.map((value) => (
                  <option key={value} value={value}>
                    {goalLabels[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              说明（可选）
              <textarea
                rows={2}
                maxLength={4000}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label className="field">
              标准词书文件
              <input
                ref={fileInput}
                type="file"
                accept=".pdf,.docx,.txt"
                required
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                }}
              />
            </label>
            {file && (
              <p className="fine-print">
                {file.name} · {(file.size / 1024).toFixed(1)} KiB
              </p>
            )}
            <button className="button primary" disabled={!!busy || !file}>
              <FileUp size={16} />
              {busy === 'upload' ? '正在解析与核对…' : '生成导入预览'}
            </button>
          </form>
        </Panel>
      </div>
      {preview && (
        <Panel className="custom-preview-panel">
          <div className="section-heading">
            <div>
              <span className="tiny-label">3. 核对实际结果</span>
              <h2>{preview.import.title}</h2>
            </div>
            <span className="soft-badge">
              {preview.import.status === 'confirmed'
                ? '已确认'
                : expired
                  ? '预览已到期'
                  : '待确认预览'}
            </span>
          </div>
          <p className="fine-print">
            {preview.import.filename} · 预览有效至 {adminTime(preview.import.expiresAt)}
          </p>
          <div className="import-metrics">
            {[
              { label: '总行数', value: preview.import.counts.totalRows },
              { label: '合格', value: preview.import.counts.ready },
              { label: '失败', value: preview.import.counts.failed },
              { label: '重复', value: preview.import.counts.duplicates },
            ].map((value) => (
              <div key={value.label}>
                <span>{value.label}</span>
                <strong>{value.value}</strong>
              </div>
            ))}
          </div>
          <p className="fine-print">
            缺发音或音标 {preview.import.counts.missingPronunciation} 行 · 未收录{' '}
            {preview.import.counts.notFound} 行 · 缺中文释义{' '}
            {preview.import.counts.missingDefinition} 行。原因可能重叠，不相加作为总失败数。
          </p>
          <div className="tab-row">
            {(Object.keys(previewLabels) as (keyof typeof previewLabels)[]).map((value) => (
              <button
                key={value}
                disabled={!!busy}
                className={filter === value ? 'active' : ''}
                onClick={() => void loadPage('', value)}
              >
                {previewLabels[value]}
              </button>
            ))}
          </div>
          {busy === 'page' && <Loading text="正在读取这一页预览…" />}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>原始行</th>
                  <th>词形</th>
                  <th>状态</th>
                  <th>校验与原因</th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((row) => (
                  <tr key={row.lineNumber}>
                    <td>{row.lineNumber}</td>
                    <td>
                      <strong>{row.text}</strong>
                      {row.lemma && row.lemma !== row.text && (
                        <small className="source-line">词典词形：{row.lemma}</small>
                      )}
                    </td>
                    <td>{previewLabels[row.status]}</td>
                    <td>
                      {row.reasons.length
                        ? row.reasons.map((reason) => (
                            <div key={reason.code} className="preview-reason">
                              {reason.message}
                              <small>{reason.code}</small>
                            </div>
                          ))
                        : '中文释义、英美IPA与两类口音音源已就绪'}
                      {row.readiness && (
                        <div className="readiness-badges">
                          {[
                            { key: 'definition', label: '中文义' },
                            { key: 'phoneticUs', label: '美式IPA' },
                            { key: 'phoneticUk', label: '英式IPA' },
                            { key: 'audioUs', label: '美式音源' },
                            { key: 'audioUk', label: '英式音源' },
                          ].map((value) => (
                            <span
                              key={value.key}
                              className={
                                row.readiness![value.key as keyof typeof row.readiness]
                                  ? 'ready'
                                  : 'missing'
                              }
                            >
                              {value.label}{' '}
                              {row.readiness![value.key as keyof typeof row.readiness] ? '✓' : '缺'}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!preview.items.length && <p className="fine-print">此筛选下没有行。</p>}
          <div className="pagination-actions">
            <span className="fine-print">当前筛选共 {preview.page.total} 行 · 每页100行</span>
            {cursor && (
              <button
                className="button ghost"
                disabled={!!busy}
                onClick={() => void loadPage('', filter)}
              >
                返回首屏
              </button>
            )}
            {preview.page.hasMore && preview.page.nextCursor && (
              <button
                className="button ghost"
                disabled={!!busy}
                onClick={() => void loadPage(preview.page.nextCursor!, filter)}
              >
                下一页预览
              </button>
            )}
          </div>
          <div className="action-row">
            {(['txt', 'tsv'] as const).map((format) => (
              <button
                key={format}
                className="button ghost"
                disabled={!!busy}
                onClick={() =>
                  void exportFile(
                    `custom-books/imports/${encodeURIComponent(preview.import.id)}/failures?format=${format}`,
                    `词书失败清单.${format}`,
                  )
                }
              >
                <Download size={15} />
                导出失败清单 {format.toUpperCase()}
              </button>
            ))}
            {preview.import.status === 'preview' ? (
              <button
                className="button primary"
                disabled={!!busy || expired || !preview.import.counts.ready}
                onClick={() =>
                  setConfirmation({
                    title: '创建这本私有词书？',
                    message: `将把“${preview.import.title}”中服务端确认合格的 ${preview.import.counts.ready} 个词加入你的私有词书，失败与重复项会跳过。不会创建虚构词义或音频。`,
                    label: '确认仅加入合格词',
                    run: confirm,
                  })
                }
              >
                {busy === 'confirm' ? '正在创建…' : '确认合格词并创建'}
              </button>
            ) : (
              <Link className="button primary" to="/books/mine">
                查看我的词书 <ArrowRight size={16} />
              </Link>
            )}
          </div>
        </Panel>
      )}
      <AdminConfirm action={confirmation} onClose={() => setConfirmation(null)} />
    </div>
  );
}

export function MyBooksPage() {
  const { user, scope } = useApp();
  const client = useQueryClient();
  const navigate = useNavigate();
  const books = useRemote<{ items: Book[] }>('custom-books', 'custom-books?status=all', !!user);
  const [filter, setFilter] = useState<'all' | 'published' | 'archived'>('published');
  const [editing, setEditing] = useState<Book | null>(null);
  const [confirmation, setConfirmation] = useState<AdminConfirmation | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setEditing(null);
    setConfirmation(null);
    setError(null);
    setNotice('');
    setBusy('');
  }, [scope]);
  async function select(book: Book) {
    const requestId = generation.current;
    setBusy(book.id);
    setError(null);
    try {
      await post(`books/${encodeURIComponent(book.id)}/select`, {});
      if (generation.current !== requestId) return;
      await client.invalidateQueries({ queryKey: [scope] });
      if (generation.current !== requestId) return;
      navigate('/learn');
    } catch (value) {
      if (generation.current === requestId) setError(value);
    } finally {
      if (generation.current === requestId) setBusy('');
    }
  }
  async function save() {
    if (!editing) return;
    const requestId = generation.current;
    setBusy(editing.id);
    setError(null);
    try {
      await post(
        `custom-books/${encodeURIComponent(editing.id)}`,
        {
          title: editing.title,
          description: editing.description,
          status: editing.status === 'archived' ? 'archived' : 'published',
        },
        'PATCH',
      );
      if (generation.current !== requestId) return;
      setEditing(null);
      await client.invalidateQueries({ queryKey: [scope] });
      if (generation.current !== requestId) return;
      setNotice('私有词书设置已保存。');
    } catch (value) {
      if (generation.current === requestId) setError(value);
    } finally {
      if (generation.current === requestId) setBusy('');
    }
  }
  async function archive(book: Book) {
    const requestId = generation.current;
    setBusy(book.id);
    setError(null);
    try {
      await post(`custom-books/${encodeURIComponent(book.id)}`, {}, 'DELETE');
      if (generation.current !== requestId) return;
      await client.invalidateQueries({ queryKey: [scope] });
      if (generation.current !== requestId) return;
      setNotice('词书已归档，学习进度与已签发学习组的内容快照保留。');
    } catch (value) {
      if (generation.current === requestId) setError(value);
    } finally {
      if (generation.current === requestId) setBusy('');
    }
  }
  if (!user)
    return (
      <div className="page">
        <LoginPrompt />
      </div>
    );
  const items =
    books.data?.items.filter((book) => filter === 'all' || book.status === filter) ?? [];
  return (
    <div className="page custom-book-page">
      <Heading
        eyebrow="我的词书 · 私有学习内容"
        title={
          <>
            让自己的词书，<em>继续陪你积累。</em>
          </>
        }
        description="这些词书只对你的本站账户可见。同词仍共享一份学习进度，归档不会清除已学记录。"
        action={
          <Link className="button primary" to="/books/import">
            <Plus size={16} />
            导入自定义词书
          </Link>
        }
      />
      <div className="tab-row">
        {[
          { id: 'published', label: '可学习' },
          { id: 'archived', label: '已归档' },
          { id: 'all', label: '全部' },
        ].map((value) => (
          <button
            key={value.id}
            className={filter === value.id ? 'active' : ''}
            onClick={() => setFilter(value.id as typeof filter)}
          >
            {value.label}
          </button>
        ))}
      </div>
      <ErrorNotice error={error ?? books.error} />
      {notice && <Notice>{notice}</Notice>}
      {books.isPending && <Loading text="正在读取你的私有词书…" />}
      {!books.isPending && !items.length && (
        <Empty
          title="这里还没有词书。"
          description="使用标准PDF、DOCX或TXT模板导入，核对预览后生成自己的私有词书。"
          action={
            <Link className="button ghost" to="/books/import">
              <FileUp size={16} />
              开始导入
            </Link>
          }
        />
      )}
      <div className="private-book-grid">
        {items.map((book) => (
          <Panel key={book.id} className="private-book-card">
            <div className="panel-title">
              <BookOpen size={20} />
              <h2>{book.title}</h2>
            </div>
            <span className="soft-badge">
              仅自己可见 · {book.status === 'archived' ? '已归档' : '可学习'}
            </span>
            <p>{book.description || '暂无词书说明'}</p>
            <p className="fine-print">
              {book.wordCount} 个词 · 已学 {book.learnedCount} 个 · {goalLabels[book.goal]} ·{' '}
              {book.version}
            </p>
            <div className="action-row">
              {book.status !== 'archived' && (
                <button
                  className="button primary"
                  disabled={!!busy}
                  onClick={() => void select(book)}
                >
                  选择并学习 <ArrowRight size={16} />
                </button>
              )}
              <button className="button ghost" disabled={!!busy} onClick={() => setEditing(book)}>
                <Pencil size={15} />
                编辑
              </button>
              {book.status !== 'archived' && (
                <button
                  className="button quiet"
                  disabled={!!busy}
                  onClick={() =>
                    setConfirmation({
                      title: '归档这本私有词书？',
                      message: `将归档“${book.title}”，它不再作为新学习组来源。已有学习进度与已签发组的内容快照会保留，也可之后恢复词书。`,
                      label: '确认归档',
                      run: () => archive(book),
                    })
                  }
                >
                  <Archive size={15} />
                  归档
                </button>
              )}
            </div>
          </Panel>
        ))}
      </div>
      <Dialog open={!!editing} title="编辑我的词书" onClose={() => setEditing(null)}>
        {editing && (
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="field">
              标题
              <input
                required
                maxLength={160}
                value={editing.title}
                onChange={(event) => setEditing({ ...editing, title: event.target.value })}
              />
            </label>
            <label className="field">
              说明
              <textarea
                maxLength={4000}
                rows={3}
                value={editing.description}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
              />
            </label>
            <label className="field">
              状态
              <select
                value={editing.status ?? 'published'}
                onChange={(event) =>
                  setEditing({ ...editing, status: event.target.value as 'published' | 'archived' })
                }
              >
                <option value="published">可学习</option>
                <option value="archived">归档</option>
              </select>
            </label>
            <ErrorNotice error={error} />
            <button className="button primary" disabled={!!busy}>
              保存词书
            </button>
          </form>
        )}
      </Dialog>
      <AdminConfirm action={confirmation} onClose={() => setConfirmation(null)} />
    </div>
  );
}
