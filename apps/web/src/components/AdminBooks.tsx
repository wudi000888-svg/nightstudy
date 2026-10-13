import { useState } from 'react';
import { Plus, Save } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useApp, useRemote } from '../AppContext';
import { post } from '../lib/api';
import { goalLabels, goalNames, type Goal, type Word } from '../lib/types';
import { Dialog, Empty, ErrorNotice, Loading, Notice, Panel } from './UI';
interface ManagedBook {
  id: string;
  slug: string;
  title: string;
  description: string;
  goal: Goal;
  version: string;
  status: string;
}
interface Draft {
  title: string;
  description: string;
  slug: string;
  goal: Goal;
  status: 'draft' | 'published' | 'archived';
}
const fresh: Draft = { title: '', description: '', slug: '', goal: 'daily', status: 'draft' };
export function AdminBooks() {
  const { scope } = useApp();
  const client = useQueryClient();
  const books = useRemote<{ items: ManagedBook[] }>('admin-books', 'admin/books');
  const words = useRemote<{ items: Word[] }>('admin-book-candidates', 'admin/words');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedBook | null>(null);
  const [draft, setDraft] = useState<Draft>(fresh);
  const [wordIds, setWordIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  function create() {
    setEditing(null);
    setDraft({ ...fresh });
    setWordIds([]);
    setOpen(true);
    setError(null);
  }
  function edit(book: ManagedBook) {
    setEditing(book);
    setDraft({
      title: book.title,
      description: book.description,
      slug: book.slug,
      goal: book.goal,
      status: book.status as Draft['status'],
    });
    setOpen(true);
    setError(null);
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await post(
        editing ? `admin/books/${editing.id}` : 'admin/books',
        {
          title: draft.title,
          description: draft.description,
          goal: draft.goal,
          status: draft.status,
          ...(!editing ? { slug: draft.slug, wordIds } : {}),
        },
        editing ? 'PATCH' : 'POST',
      );
      await client.invalidateQueries({ queryKey: [scope] });
      setOpen(false);
      setNotice(
        editing
          ? '词书信息已保存，进行中的学习组继续使用原内容快照。'
          : '词书已创建。草稿不会出现在公开词书大厅。',
      );
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Panel>
        <div className="section-heading">
          <div>
            <h2>本站词书</h2>
            <p className="fine-print">从已有、来源明确的词条建立一条学习路径。</p>
          </div>
          <button className="button primary" onClick={create}>
            <Plus size={15} />
            新词书
          </button>
        </div>
        <ErrorNotice error={books.error} />
        {notice && <Notice>{notice}</Notice>}
        {books.isPending ? (
          <Loading />
        ) : books.data?.items.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>词书</th>
                  <th>介绍</th>
                  <th>版本</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {books.data.items.map((book) => (
                  <tr key={book.id}>
                    <td>{book.title}</td>
                    <td>{book.description}</td>
                    <td>{book.version}</td>
                    <td>
                      {book.status === 'published'
                        ? '已发布'
                        : book.status === 'draft'
                          ? '草稿'
                          : '归档'}
                    </td>
                    <td>
                      <button className="button quiet" onClick={() => edit(book)}>
                        编辑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="还没有词书。" description="用已经发布的内容，创建本站第一本词书。" />
        )}
      </Panel>
      <Dialog
        open={open}
        title={editing ? '编辑本站词书' : '新建一本词书'}
        onClose={() => setOpen(false)}
      >
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <ErrorNotice error={error} />
          <label className="field">
            词书标题
            <input
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              required
              maxLength={160}
            />
          </label>
          {!editing && (
            <label className="field">
              唯一短名
              <input
                value={draft.slug}
                onChange={(event) => setDraft({ ...draft, slug: event.target.value })}
                required
                pattern="[a-z0-9-]{2,80}"
                placeholder="evening-vocabulary"
              />
              <small className="fine-print">英文小写、数字和短横线。</small>
            </label>
          )}
          <label className="field">
            介绍
            <textarea
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              rows={3}
              maxLength={4000}
            />
          </label>
          <div className="form-columns">
            <label className="field">
              目标
              <select
                value={draft.goal}
                onChange={(event) => setDraft({ ...draft, goal: event.target.value as Goal })}
              >
                {goalNames.map((goal) => (
                  <option value={goal} key={goal}>
                    {goalLabels[goal]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              状态
              <select
                value={draft.status}
                onChange={(event) =>
                  setDraft({ ...draft, status: event.target.value as Draft['status'] })
                }
              >
                <option value="draft">草稿</option>
                <option value="published">发布</option>
                {editing && <option value="archived">归档</option>}
              </select>
            </label>
          </div>
          {!editing && (
            <div>
              <span className="field-label">选择词成员 · {wordIds.length} 词</span>
              <div className="word-selector">
                {words.data?.items
                  .filter((word) => word.status !== 'archived')
                  .map((word) => (
                    <label key={word.id}>
                      <input
                        type="checkbox"
                        checked={wordIds.includes(word.id)}
                        onChange={(event) =>
                          setWordIds(
                            event.target.checked
                              ? [...wordIds, word.id]
                              : wordIds.filter((id) => id !== word.id),
                          )
                        }
                      />
                      <strong>{word.lemma}</strong>
                      <small>{word.senses?.[0]?.definitionZh}</small>
                    </label>
                  ))}
              </div>
              <ErrorNotice error={words.error} />
            </div>
          )}
          {editing && <p className="fine-print">本次保留现有词成员，更新信息或发布状态。</p>}
          <button className="button primary" disabled={busy || (!editing && wordIds.length === 0)}>
            <Save size={16} />
            {busy ? '正在保存…' : '保存词书'}
          </button>
        </form>
      </Dialog>
    </>
  );
}
