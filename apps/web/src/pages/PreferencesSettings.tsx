import { useEffect, useState } from 'react';
import { useLearningPreferences } from '../LearningPreferences';
import { usePageLifetime } from './usePageLifetime';
import { ErrorNotice, Loading, Notice } from '../components/UI';

export function PreferencesSettings() {
  const { preferences, loaded, saving, error, savePreferences, resetError, reloadPreferences } =
    useLearningPreferences();
  const owner = usePageLifetime();
  const [draft, setDraft] = useState(preferences);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setDraft(preferences);
  }, [preferences]);
  const edit = (value: typeof preferences) => {
    setDraft(value);
    setSaved(false);
  };
  if (!loaded)
    return (
      <>
        <ErrorNotice error={error} onRetry={() => void reloadPreferences()} />
        <Loading text="正在读取学习偏好…" />
      </>
    );
  return (
    <form
      className="form-stack mobile-preferences"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        resetError();
        const { revision: _revision, ...patch } = draft;
        const request = owner.capture();
        void savePreferences(patch).then((ok) => {
          if (ok && owner.isCurrent(request)) setSaved(true);
        });
      }}
    >
      <fieldset>
        <legend>默认发音</legend>
        <div className="mobile-choice-row">
          {(
            [
              ['us', '美式英语 US'],
              ['uk', '英式英语 UK'],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              className={draft.accent === value ? 'selected' : ''}
              aria-pressed={draft.accent === value}
              key={value}
              onClick={() => edit({ ...draft, accent: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="mobile-setting-toggle">
        <span>
          <strong>自动播放单词发音</strong>
          <small>进入词卡时播放默认口音，浏览器可能需要先点一次播放。</small>
        </span>
        <input
          type="checkbox"
          checked={draft.autoPlay}
          onChange={(event) => edit({ ...draft, autoPlay: event.target.checked })}
        />
      </label>
      <label className="mobile-setting-toggle">
        <span>
          <strong>拼写练习</strong>
          <small>学习时安排拼写，帮助检查是否能独立写出单词。</small>
        </span>
        <input
          type="checkbox"
          checked={draft.spellingEnabled}
          onChange={(event) => edit({ ...draft, spellingEnabled: event.target.checked })}
        />
      </label>
      <label className="field">
        学习字号
        <select
          value={draft.fontScale}
          onChange={(event) =>
            edit({ ...draft, fontScale: Number(event.target.value) as 1 | 1.125 | 1.25 })
          }
        >
          <option value={1}>标准 · 16px</option>
          <option value={1.125}>较大 · 18px</option>
          <option value={1.25}>大字 · 20px</option>
        </select>
      </label>
      <fieldset>
        <legend>界面主题</legend>
        <div className="mobile-choice-row">
          {(
            [
              ['day', '白天'],
              ['night', '夜读'],
              ['system', '跟随系统'],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={draft.theme === value ? 'selected' : ''}
              aria-pressed={draft.theme === value}
              onClick={() => edit({ ...draft, theme: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="mobile-setting-toggle">
        <span>
          <strong>站内学习提醒</strong>
          <small>页面打开时，按当前设备的当地时间提醒。</small>
        </span>
        <input
          type="checkbox"
          checked={draft.reminderEnabled}
          onChange={(event) => edit({ ...draft, reminderEnabled: event.target.checked })}
        />
      </label>
      {draft.reminderEnabled && (
        <label className="field">
          提醒时间
          <input
            type="time"
            required
            value={draft.reminderTime}
            onChange={(event) => edit({ ...draft, reminderTime: event.target.value })}
          />
        </label>
      )}
      <p className="mobile-caption">
        站内提醒不发送离线推送或系统通知。学习日仍按计划设置的时区与凌晨4点计算。
      </p>
      <ErrorNotice error={error} onRetry={() => void reloadPreferences()} />
      {saved && <Notice>学习偏好已保存。</Notice>}
      <button className="button primary" disabled={saving}>
        {saving ? '正在保存…' : '保存学习偏好'}
      </button>
    </form>
  );
}
