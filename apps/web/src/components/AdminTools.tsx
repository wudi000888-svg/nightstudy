import { useState } from 'react';
import { Copy, ExternalLink, KeyRound, X } from 'lucide-react';
import type { SystemUpdate } from '../lib/types';
import { ErrorNotice, Notice, Panel } from './UI';

export function adminTime(value: string | null | undefined) {
  if (!value) return '尚未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '时间不可用'
    : new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
}

export function publicHttpsUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

const updateLabels: Record<SystemUpdate['status'], string> = {
  unchecked: '尚未检测更新',
  'up-to-date': '当前版本已是最新发布',
  available: '有新版本可用',
  ahead: '当前版本领先于最新发布',
  'no-release': '该渠道尚无发布版本',
  failed: '这次检测未完成',
};

export function AdminUpdateStatus({
  value,
  compact = false,
}: {
  value: SystemUpdate;
  compact?: boolean;
}) {
  const releaseUrl = publicHttpsUrl(value.releaseUrl);
  return (
    <div className={`admin-update-result ${compact ? 'compact' : ''}`}>
      <Notice>{updateLabels[value.status]}</Notice>
      <p>{value.message}</p>
      <div className="management-meta">
        <span className="soft-badge">
          {value.channel === 'prerelease' ? '预发布渠道' : '稳定渠道'}
        </span>
        {value.latestVersion && (
          <span className="fine-print">
            {value.stale ? '最近成功发布' : '最新发布'}：{value.latestVersion}
          </span>
        )}
      </div>
      <p className="fine-print">
        最近检测：{adminTime(value.checkedAt)}
        {value.cached ? ' · 使用缓存结果' : ''}
      </p>
      {value.stale && (
        <p className="fine-print">
          本次未取得新发布结果，保留上次成功信息。最近成功检测：{adminTime(value.lastSuccessfulAt)}
        </p>
      )}
      {releaseUrl && (
        <a className="button ghost" href={releaseUrl} target="_blank" rel="noopener noreferrer">
          查看发布说明 <ExternalLink size={15} />
        </a>
      )}
    </div>
  );
}

export function PairingSecret({
  token,
  expiresAt,
  onDismiss,
}: {
  token: string;
  expiresAt: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function copy() {
    setError(null);
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setError(new Error('暂时无法使用剪贴板，请手动选择并复制令牌。'));
    }
  }
  return (
    <Panel className="pairing-secret">
      <div className="section-heading">
        <div className="panel-title">
          <KeyRound size={18} />
          <h2>保存这次配对令牌</h2>
        </div>
        <button className="icon-button" aria-label="关闭令牌显示" onClick={onDismiss}>
          <X size={18} />
        </button>
      </div>
      <p>完整令牌只显示这一次。请交给你信任的控制端管理员，刷新或离开本页后无法再次读取。</p>
      <label className="field">
        一次性配对令牌
        <textarea
          readOnly
          value={token}
          rows={3}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
      <div className="action-row">
        <button className="button ghost" onClick={() => void copy()}>
          <Copy size={16} /> 复制令牌
        </button>
        <span className="fine-print">到期时间：{adminTime(expiresAt)}</span>
      </div>
      {copied && <Notice>令牌已复制到剪贴板。</Notice>}
      <ErrorNotice error={error} />
    </Panel>
  );
}
