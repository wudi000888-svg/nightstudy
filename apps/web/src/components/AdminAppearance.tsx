import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ImagePlus, RotateCcw, Save } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { ApiError, post } from '../lib/api';
import type { HomeAppearance } from '../lib/home-atmosphere';
import { usePageLifetime } from '../pages/usePageLifetime';
import { HomeAtmosphere } from './HomeAtmosphere';
import { ErrorNotice, Loading, Notice, Panel } from './UI';

interface AppearanceResponse {
  appearance: HomeAppearance;
}
const acceptedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxFileSize = 4 * 1024 * 1024;

export function validateWallpaperFile(file: Pick<File, 'type' | 'size'>) {
  if (!acceptedTypes.has(file.type)) return '请选择 JPG、PNG 或 WebP 图片。';
  if (file.size < 1 || file.size > maxFileSize) return '图片需要大于 0 且不超过 4 MiB。';
  return null;
}

function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片未能读取，请重新选择。'));
    reader.onload = () => {
      const data = String(reader.result ?? '');
      const comma = data.indexOf(',');
      if (comma < 0) reject(new Error('图片未能读取，请重新选择。'));
      else resolve(data.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function AdminAppearance() {
  const { scope, user } = useApp();
  const owner = usePageLifetime();
  const queryClient = useQueryClient();
  const query = useRemote<AppearanceResponse>(
    'admin-appearance',
    'admin/appearance',
    user?.role === 'admin',
  );
  const [draft, setDraft] = useState<HomeAppearance | null>(null);
  const [dirty, setDirty] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (query.data && !dirty && !working.current) setDraft(query.data.appearance);
  }, [query.data, dirty]);
  useEffect(() => {
    setPreviewUrl(undefined);
    if (!file) {
      return;
    }
    let current = true;
    const reader = new FileReader();
    reader.onload = () => {
      if (current && typeof reader.result === 'string') setPreviewUrl(reader.result);
    };
    reader.readAsDataURL(file);
    return () => {
      current = false;
      reader.abort();
    };
  }, [file]);

  const edit = (patch: Partial<HomeAppearance>) => {
    if (working.current || !draft) return;
    setDraft({ ...draft, ...patch });
    setDirty(true);
    setNotice('');
  };
  const selectImage = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0];
    event.target.value = '';
    if (!next || working.current || !draft) return;
    const problem = validateWallpaperFile(next);
    if (problem) {
      setError(new Error(problem));
      return;
    }
    setError(null);
    setFile(next);
    edit({ mode: 'custom' });
  };

  const remember = (response: AppearanceResponse) => {
    queryClient.setQueryData([scope, 'admin-appearance', 'admin/appearance'], response);
    queryClient.setQueryData([scope, 'site-appearance', 'appearance'], response);
    setDraft(response.appearance);
    setDirty(false);
    setFile(null);
  };
  async function save(reset = false) {
    if (!draft || working.current || conflict || user?.role !== 'admin') return;
    working.current = true;
    setBusy(true);
    setError(null);
    setNotice('');
    const ticket = owner.capture();
    let revision = draft.revision;
    try {
      let result: AppearanceResponse;
      if (reset) {
        result = await post<AppearanceResponse>('admin/appearance/reset', {
          expectedRevision: revision,
        });
      } else {
        if (file && draft.mode === 'custom') {
          const dataBase64 = await fileBase64(file);
          if (!owner.isCurrent(ticket)) return;
          const uploaded = await post<AppearanceResponse>('admin/appearance/wallpaper', {
            expectedRevision: revision,
            fileName: file.name,
            contentType: file.type,
            dataBase64,
          });
          if (!owner.isCurrent(ticket)) return;
          // Upload and settings are separately revisioned. Retrying never submits
          // the pre-upload revision or silently re-uploads the same local file.
          revision = uploaded.appearance.revision;
          queryClient.setQueryData([scope, 'admin-appearance', 'admin/appearance'], uploaded);
          queryClient.setQueryData([scope, 'site-appearance', 'appearance'], uploaded);
          setDraft({ ...draft, imageUrl: uploaded.appearance.imageUrl, revision });
          setFile(null);
        }
        result = await post<AppearanceResponse>(
          'admin/appearance',
          {
            expectedRevision: revision,
            mode: draft.mode,
            positionX: draft.positionX,
            positionY: draft.positionY,
            overlay: draft.overlay,
            animationEnabled: draft.animationEnabled,
          },
          'PUT',
        );
      }
      if (!owner.isCurrent(ticket)) return;
      remember(result);
      setNotice(reset ? '已恢复雨夜窗景。' : '首页外观已保存。');
    } catch (value) {
      if (!owner.isCurrent(ticket)) return;
      if (value instanceof ApiError && value.status === 409) {
        setConflict(true);
        setError(new Error('首页外观已在另一处更新。请先读取最新设置，再调整并保存。'));
      } else setError(value);
    } finally {
      working.current = false;
      if (owner.isCurrent(ticket)) setBusy(false);
    }
  }
  async function reload() {
    if (working.current) return;
    const ticket = owner.capture();
    setError(null);
    const result = await query.refetch();
    if (!owner.isCurrent(ticket)) return;
    if (result.data) {
      remember(result.data);
      setConflict(false);
      setNotice('已读取最新首页外观。');
    }
  }
  if (!draft)
    return (
      <Panel>
        <ErrorNotice error={query.error} onRetry={() => void reload()} />
        <Loading text="正在读取首页外观…" />
      </Panel>
    );
  return (
    <Panel className="admin-appearance">
      <div className="admin-appearance-heading">
        <div>
          <h2>首页外观</h2>
          <p>让每次打开，都像回到自己的自习室。</p>
        </div>
        <span className="tiny-label">{dirty ? '尚未保存' : '当前站点'}</span>
      </div>
      <div className="admin-appearance-layout">
        <div className="admin-wallpaper-preview" aria-label="首页壁纸静态预览">
          <HomeAtmosphere appearance={draft} preview previewImageUrl={previewUrl} />
          <div className="admin-preview-avatar">☾</div>
          <div className="admin-preview-checkin">
            <span>☾</span>
            <strong>签到</strong>
          </div>
          <div className="admin-preview-actions">
            <span>Learn</span>
            <span>Review</span>
          </div>
          <small>预览</small>
        </div>
        <form
          className="form-stack admin-appearance-controls"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy || conflict}>
            <legend>壁纸</legend>
            <div className="mobile-choice-row">
              {[
                ['rain-night', '雨夜窗景'],
                ['custom', '我的壁纸'],
              ].map(([mode, label]) => (
                <button
                  type="button"
                  key={mode}
                  className={draft.mode === mode ? 'selected' : ''}
                  aria-pressed={draft.mode === mode}
                  disabled={mode === 'custom' && !draft.imageUrl && !file}
                  onClick={() => edit({ mode: mode as HomeAppearance['mode'] })}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={selectImage}
              className="admin-wallpaper-file"
              aria-label="选择首页壁纸图片"
            />
            <button
              type="button"
              className="button ghost"
              onClick={() => fileInput.current?.click()}
            >
              <ImagePlus size={17} /> {file ? '重新选择图片' : '上传自己的壁纸'}
            </button>
            <p className="fine-print">JPG、PNG 或 WebP，最多 4 MiB。建议使用竖向图片。</p>
            {file && <p className="fine-print">已选择 {file.name}，保存后应用。</p>}
          </fieldset>
          {draft.mode === 'custom' && (
            <fieldset disabled={busy || conflict}>
              <legend>构图与明暗</legend>
              <label className="admin-wallpaper-range">
                水平焦点 <output>{Math.round(draft.positionX)}%</output>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={draft.positionX}
                  onChange={(event) => edit({ positionX: Number(event.target.value) })}
                />
              </label>
              <label className="admin-wallpaper-range">
                垂直焦点 <output>{Math.round(draft.positionY)}%</output>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={draft.positionY}
                  onChange={(event) => edit({ positionY: Number(event.target.value) })}
                />
              </label>
              <label className="admin-wallpaper-range">
                深色遮罩 <output>{Math.round(draft.overlay * 100)}%</output>
                <input
                  type="range"
                  min="0"
                  max="85"
                  value={Math.round(draft.overlay * 100)}
                  onChange={(event) => edit({ overlay: Number(event.target.value) / 100 })}
                />
              </label>
            </fieldset>
          )}
          <label className="mobile-setting-toggle">
            <span>
              <strong>允许首页动态雨景</strong>
              <small>学习者可单独关闭。减少动态、省流、离开首页时自动静止。</small>
            </span>
            <input
              type="checkbox"
              checked={draft.animationEnabled}
              disabled={busy || conflict}
              onChange={(event) => edit({ animationEnabled: event.target.checked })}
            />
          </label>
          <ErrorNotice error={error} />
          {conflict && (
            <button
              type="button"
              className="button ghost"
              disabled={busy}
              onClick={() => void reload()}
            >
              读取最新首页外观
            </button>
          )}
          {notice && <Notice>{notice}</Notice>}
          <div className="admin-appearance-buttons">
            <button className="button primary" disabled={busy || conflict || !dirty}>
              <Save size={17} /> {busy ? '正在保存…' : '保存首页外观'}
            </button>
            <button
              type="button"
              className="button ghost"
              disabled={busy || conflict}
              onClick={() => void save(true)}
            >
              <RotateCcw size={16} /> 恢复雨夜窗景
            </button>
          </div>
          <p className="fine-print">
            设置只影响本站首页。学习词卡与其他页面仍使用个人选择的明暗主题。
          </p>
        </form>
      </div>
    </Panel>
  );
}
