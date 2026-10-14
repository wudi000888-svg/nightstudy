import { useRef, useState } from 'react';
import { KeyRound, Link2, Network, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { useRemote } from '../AppContext';
import { newId, post } from '../lib/api';
import type {
  AdminAnnouncement,
  FleetPairingToken,
  FleetScope,
  FleetSite,
  FleetSummary,
  FleetUser,
  SystemUpdate,
} from '../lib/types';
import { AdminConfirm, type AdminConfirmation } from './AdminConfirm';
import { AdminUpdateStatus, adminTime, PairingSecret } from './AdminTools';
import { Empty, ErrorNotice, Loading, Notice, Panel } from './UI';

const scopes: { id: FleetScope; label: string }[] = [
  { id: 'status:read', label: '查看状态' },
  { id: 'users:read', label: '查看用户' },
  { id: 'users:write', label: '启停用户' },
  { id: 'settings:write', label: '切换注册开放' },
  { id: 'announcements:write', label: '管理公告' },
];
const siteStatuses: Record<FleetSite['status'], string> = {
  active: '已连接',
  unreachable: '暂时无法连接',
  revoked: '已解绑',
  disconnect_pending: '等待远程撤销',
  forgotten: '已本地忘记',
};
const tokenStatuses: Record<FleetPairingToken['status'], string> = {
  active: '待配对',
  used: '已使用',
  revoked: '已撤销',
  expired: '已过期',
};

function ScopeBadges({ values }: { values: FleetScope[] }) {
  return (
    <div className="management-meta">
      {values.map((value) => (
        <span className="soft-badge" key={value}>
          {scopes.find((scope) => scope.id === value)?.label ?? value}
        </span>
      ))}
    </div>
  );
}

export function AdminFleet() {
  const fleet = useRemote<FleetSummary>('admin-fleet', 'admin/fleet');
  const [confirmation, setConfirmation] = useState<AdminConfirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [tokenLabel, setTokenLabel] = useState('');
  const [allowedScopes, setAllowedScopes] = useState<FleetScope[]>(scopes.map((scope) => scope.id));
  const [secret, setSecret] = useState<{ token: string; expiresAt: string } | null>(null);
  const [targetUrl, setTargetUrl] = useState('');
  const targetUrlRef = useRef<HTMLInputElement>(null);
  const [targetToken, setTargetToken] = useState('');
  const [targetLabel, setTargetLabel] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [checkedUpdates, setCheckedUpdates] = useState<Record<string, SystemUpdate>>({});
  const [checkingId, setCheckingId] = useState('');
  const selected = fleet.data?.sites.find((site) => site.id === selectedId);
  async function mutate(operation: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const result = await operation();
      await fleet.refetch();
      setNotice(result);
    } catch (value) {
      setError(value);
      await fleet.refetch();
    } finally {
      setBusy(false);
    }
  }
  async function generateToken() {
    await mutate(async () => {
      const result = await post<{ pairingToken: FleetPairingToken; token: string }>(
        'admin/fleet/pairing-tokens',
        { label: tokenLabel.trim() || undefined, scopes: allowedScopes },
      );
      setSecret({ token: result.token, expiresAt: result.pairingToken.expiresAt });
      setTokenLabel('');
      return '配对令牌已生成，请在下方保存完整令牌。';
    });
  }
  async function connect() {
    await mutate(async () => {
      const result = await post<{ site: FleetSite }>('admin/fleet/sites', {
        url: targetUrl.trim(),
        token: targetToken.trim(),
        label: targetLabel.trim() || undefined,
      });
      setTargetToken('');
      setTargetUrl('');
      setTargetLabel('');
      setSelectedId(result.site.id);
      return '站点已接入，授权范围由目标站配对令牌决定。';
    });
  }
  async function revokeToken(value: FleetPairingToken) {
    await mutate(async () => {
      await post(`admin/fleet/pairing-tokens/${encodeURIComponent(value.id)}`, {}, 'DELETE');
      setSecret(null);
      return '待配对令牌已撤销。已授权的控制端需从下方单独撤销。';
    });
  }
  async function revokeController(id: string) {
    await mutate(async () => {
      await post(`admin/fleet/controllers/${encodeURIComponent(id)}`, {}, 'DELETE');
      return '控制端授权已撤销，该控制端无法继续管理本站。';
    });
  }
  async function refreshSite(value: FleetSite) {
    await mutate(async () => {
      await post(`admin/fleet/sites/${encodeURIComponent(value.id)}/refresh`, {});
      setCheckedUpdates((previous) => {
        const next = { ...previous };
        delete next[value.id];
        return next;
      });
      return '站点快照已刷新。';
    });
  }
  async function checkSiteUpdate(value: FleetSite) {
    setCheckingId(value.id);
    try {
      await mutate(async () => {
        const result = await post<{ update: SystemUpdate }>(
          `admin/fleet/sites/${encodeURIComponent(value.id)}/check-update`,
          { commandId: newId() },
        );
        setCheckedUpdates((previous) => ({ ...previous, [value.id]: result.update }));
        return '目标站更新检测已返回，请查看该站的真实检测结果。';
      });
    } finally {
      setCheckingId('');
    }
  }
  async function disconnect(value: FleetSite) {
    await mutate(async () => {
      const result = await post<{ revoked: boolean; remoteRevoked?: boolean; pending?: boolean }>(
        `admin/fleet/sites/${encodeURIComponent(value.id)}`,
        {},
        'DELETE',
      );
      if (result.pending)
        return '远程暂时无法完成授权撤销，站点进入等待撤销状态。连接恢复后请再次解绑。';
      if (!result.revoked || !result.remoteRevoked)
        throw new Error('还没有取得完整的解绑确认，请刷新站点状态后重试。');
      setSelectedId('');
      return '本站连接与远程授权已撤销。目标站的账户及学习记录仍然保留。';
    });
  }
  async function forgetSite(value: FleetSite) {
    await mutate(async () => {
      const result = await post<{
        forgotten: boolean;
        remoteRevocationConfirmed: boolean;
        site: FleetSite;
      }>(`admin/fleet/sites/${encodeURIComponent(value.id)}/forget`, {
        acknowledgeRemoteGrantMayRemain: true,
      });
      if (
        !result.forgotten ||
        result.remoteRevocationConfirmed !== false ||
        result.site.status !== 'forgotten'
      )
        throw new Error('尚未取得本地忘记的确认，请刷新列表后重试。');
      if (selectedId === value.id) setSelectedId('');
      setCheckedUpdates((previous) => {
        const next = { ...previous };
        delete next[value.id];
        return next;
      });
      return '已仅在本地忘记该连接。旧子站授权可能仍有效，请到旧子站撤销本控制端；重新接入需要新的配对令牌。';
    });
  }
  function prepareConnect() {
    setError(null);
    try {
      const url = new URL(targetUrl.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('请输入不含账号密码的完整站点网址。');
      setConfirmation({
        title: '接入这个站点？',
        message: `将用配对令牌接入 ${targetUrl.trim()}。目标站的账户与学习数据继续独立，只开放令牌允许的管理操作。`,
        label: '确认接入',
        run: connect,
      });
    } catch (value) {
      setError(value instanceof Error ? value : new Error('请输入完整站点网址。'));
    }
  }
  return (
    <div className="admin-management-grid">
      <div className="admin-management-wide">
        <Notice>
          每个站点保留独立账户与数据。配对只授权这里列出的管理能力，实例编号与站点编号共同标识目标。
        </Notice>
        <ErrorNotice error={error ?? fleet.error} />
        {notice && <Notice>{notice}</Notice>}
      </div>
      <Panel>
        <div className="panel-title">
          <KeyRound size={18} />
          <h2>允许控制端管理本站</h2>
        </div>
        <p>生成一次性令牌，交给你信任的控制端。令牌固定在10分钟后过期，配对后不能重复使用。</p>
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            setConfirmation({
              title: '生成本站配对令牌？',
              message: `持有此令牌的控制端可以获得所选授权：${scopes
                .filter((scope) => allowedScopes.includes(scope.id))
                .map((scope) => scope.label)
                .join('、')}。请只将令牌交给你信任的管理员。`,
              label: '确认生成',
              run: generateToken,
            });
          }}
        >
          <label className="field">
            令牌备注（可选）
            <input
              value={tokenLabel}
              onChange={(event) => setTokenLabel(event.target.value)}
              maxLength={120}
              placeholder="例如：我的主控面板"
            />
          </label>
          <fieldset className="fleet-scopes">
            <legend>授权范围</legend>
            {scopes.map((scope) => (
              <label key={scope.id}>
                <input
                  type="checkbox"
                  checked={allowedScopes.includes(scope.id)}
                  disabled={scope.id === 'status:read' || busy}
                  onChange={(event) =>
                    setAllowedScopes((value) =>
                      event.target.checked
                        ? [...value, scope.id]
                        : value.filter((item) => item !== scope.id),
                    )
                  }
                />
                {scope.label}
                {scope.id === 'status:read' && <small>必选</small>}
              </label>
            ))}
          </fieldset>
          <button className="button primary" disabled={busy || fleet.isPending}>
            <KeyRound size={16} />
            生成配对令牌
          </button>
        </form>
      </Panel>
      <Panel>
        <div className="panel-title">
          <Link2 size={18} />
          <h2>接入另一个站点</h2>
        </div>
        <p>先到目标站的群站管理生成配对令牌，再在这里提交网址与令牌。</p>
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            prepareConnect();
          }}
        >
          <label className="field">
            目标站网址
            <input
              type="url"
              ref={targetUrlRef}
              required
              value={targetUrl}
              onChange={(event) => setTargetUrl(event.target.value)}
              placeholder="https://你的站点域名/挂载路径"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            配对令牌
            <input
              type="password"
              required
              value={targetToken}
              onChange={(event) => setTargetToken(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            站点备注（可选）
            <input
              value={targetLabel}
              onChange={(event) => setTargetLabel(event.target.value)}
              maxLength={120}
            />
          </label>
          <button className="button primary" disabled={busy || fleet.isPending}>
            <Link2 size={16} />
            接入站点
          </button>
        </form>
      </Panel>
      {secret && (
        <div className="admin-management-wide">
          <PairingSecret key={secret.token} {...secret} onDismiss={() => setSecret(null)} />
        </div>
      )}
      <Panel className="admin-management-wide">
        <div className="section-heading">
          <div className="panel-title">
            <Network size={18} />
            <h2>我管理的站点</h2>
          </div>
          <button
            className="button ghost"
            disabled={busy || fleet.isFetching}
            onClick={() => void fleet.refetch()}
          >
            <RefreshCw size={15} />
            刷新列表
          </button>
        </div>
        {fleet.isPending && <Loading text="正在读取已接入站点…" />}
        {fleet.data?.sites.length === 0 && (
          <Empty
            title="还没有接入其他站点。"
            description="接入后会在这里显示真实站点快照与授权范围。"
          />
        )}
        <div className="management-list">
          {fleet.data?.sites.map((value) => (
            <article
              className={`management-card ${value.id === selectedId ? 'selected' : ''}`}
              key={value.id}
            >
              <div className="section-heading">
                <h3>{value.label || value.lastSnapshot?.site.title || '已接入站点'}</h3>
                <span className="soft-badge">{siteStatuses[value.status]}</span>
              </div>
              <p className="management-url">{value.remoteUrl}</p>
              <p className="fine-print">
                实例 {value.remoteInstanceId} · 站点 {value.remoteSiteId}
              </p>
              <ScopeBadges values={value.scopes} />
              {value.lastSnapshot ? (
                <>
                  <p>
                    版本 {value.lastSnapshot.site.version} ·{' '}
                    {value.lastSnapshot.counts.users.toLocaleString()} 个用户 ·{' '}
                    {value.lastSnapshot.counts.disabledUsers.toLocaleString()} 个停用用户
                  </p>
                  <p className="fine-print">
                    {value.lastSnapshot.counts.books.toLocaleString()} 本词书 ·{' '}
                    {value.lastSnapshot.counts.words.toLocaleString()} 个词条（已安装词库统计）
                  </p>
                  <p className="fine-print">快照时间：{adminTime(value.lastSnapshot.checkedAt)}</p>
                </>
              ) : (
                <p className="fine-print">尚无站点快照，请尝试刷新。</p>
              )}
              {value.lastErrorCode && (
                <p className="fleet-error-code">最近连接状态：{value.lastErrorCode}</p>
              )}
              {value.status === 'disconnect_pending' && (
                <p className="fine-print">
                  远程授权尚未确认撤销，请在目标站恢复连接后再次解绑，也可到目标站撤销本控制端。
                </p>
              )}
              {value.status === 'forgotten' && (
                <p className="fine-print">
                  本地凭据已清除，下面仅保留历史快照。旧子站授权可能仍有效，请到旧子站撤销本控制端。可用新的配对令牌重新接入同一网址。
                </p>
              )}
              {checkedUpdates[value.id] || value.lastSnapshot?.update ? (
                <AdminUpdateStatus
                  value={(checkedUpdates[value.id] ?? value.lastSnapshot?.update)!}
                  compact
                />
              ) : (
                <p className="fine-print">尚无更新检测记录。旧版子站可能需要升级后才支持此功能。</p>
              )}
              <div className="action-row">
                <button
                  className="button ghost"
                  disabled={busy || value.status !== 'active'}
                  onClick={() => setSelectedId(value.id)}
                >
                  管理本站点
                </button>
                <button
                  className="button ghost"
                  disabled={busy || !['active', 'unreachable'].includes(value.status)}
                  onClick={() => void refreshSite(value)}
                >
                  <RefreshCw size={15} />
                  刷新快照
                </button>
                <button
                  className="button ghost"
                  disabled={
                    busy ||
                    !['active', 'unreachable'].includes(value.status) ||
                    !value.scopes.includes('status:read')
                  }
                  onClick={() => void checkSiteUpdate(value)}
                >
                  <RefreshCw size={15} className={checkingId === value.id ? 'spin' : ''} />
                  {checkingId === value.id ? '正在检测…' : '检测更新'}
                </button>
                <button
                  className="button quiet"
                  disabled={busy || ['revoked', 'forgotten'].includes(value.status)}
                  onClick={() =>
                    setConfirmation({
                      title: '解绑这个站点？',
                      message: `将撤销与 ${value.label || value.remoteUrl} 的管理连接和远程授权。目标站的用户与学习记录继续保留；远程无法连接时会记录等待撤销。`,
                      label: value.status === 'disconnect_pending' ? '再次尝试解绑' : '确认解绑',
                      run: () => disconnect(value),
                    })
                  }
                >
                  {value.status === 'disconnect_pending' ? '重试解绑' : '解绑'}
                </button>
                {!['revoked', 'forgotten'].includes(value.status) && (
                  <button
                    className="button quiet"
                    disabled={busy}
                    onClick={() =>
                      setConfirmation({
                        title: '仅在本地忘记这个连接？',
                        message: `将清除 ${value.label || value.remoteUrl} 的本站连接凭据，停止从这里执行远程操作。这不会确认或执行旧子站授权撤销，旧授权可能仍有效；请到旧子站的“已授权控制端”撤销本控制端。之后可使用新的配对令牌重新接入。`,
                        label: '确认仅在本地忘记',
                        run: () => forgetSite(value),
                      })
                    }
                  >
                    仅在本地忘记
                  </button>
                )}
                {value.status === 'forgotten' && (
                  <button
                    className="button ghost"
                    disabled={busy}
                    onClick={() => {
                      setTargetUrl(value.remoteUrl);
                      setTargetLabel(value.label);
                      setTargetToken('');
                      targetUrlRef.current?.focus();
                    }}
                  >
                    用新令牌重新配对
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </Panel>
      {selected?.status === 'active' && (
        <RemoteSiteAdmin key={selected.id} site={selected} onUpdated={() => void fleet.refetch()} />
      )}
      <Panel>
        <h2>待配对与历史令牌</h2>
        {fleet.data?.pairingTokens.length === 0 && (
          <p className="fine-print">还没有生成配对令牌。</p>
        )}
        <div className="management-list">
          {fleet.data?.pairingTokens.map((value) => (
            <article className="management-card" key={value.id}>
              <div className="section-heading">
                <h3>{value.label || '配对令牌'}</h3>
                <span className="soft-badge">{tokenStatuses[value.status]}</span>
              </div>
              <ScopeBadges values={value.scopes} />
              <p className="fine-print">
                生成：{adminTime(value.createdAt)}
                <br />
                到期：{adminTime(value.expiresAt)}
              </p>
              {value.status === 'active' && (
                <button
                  className="button quiet"
                  disabled={busy}
                  onClick={() =>
                    setConfirmation({
                      title: '撤销待配对令牌？',
                      message: `将立即停止“${value.label || '配对令牌'}”的配对能力。此操作不会撤销已经授权的控制端。`,
                      label: '确认撤销令牌',
                      run: () => revokeToken(value),
                    })
                  }
                >
                  撤销令牌
                </button>
              )}
            </article>
          ))}
        </div>
      </Panel>
      <Panel>
        <div className="panel-title">
          <ShieldCheck size={18} />
          <h2>已授权控制端</h2>
        </div>
        {fleet.data?.controllers.length === 0 && (
          <p className="fine-print">本站还没有授权其他控制端。</p>
        )}
        <div className="management-list">
          {fleet.data?.controllers.map((value) => (
            <article className="management-card" key={value.id}>
              <div className="section-heading">
                <h3>{value.label || '控制端'}</h3>
                <span className="soft-badge">{value.revokedAt ? '已撤销' : '已授权'}</span>
              </div>
              <p className="management-url">{value.controllerUrl}</p>
              <p className="fine-print">
                实例 {value.controllerInstanceId} · 站点 {value.controllerSiteId}
              </p>
              <ScopeBadges values={value.scopes} />
              <p className="fine-print">
                授权：{adminTime(value.createdAt)}
                <br />
                最近使用：{adminTime(value.lastUsedAt)}
              </p>
              {!value.revokedAt && (
                <button
                  className="button quiet"
                  disabled={busy}
                  onClick={() =>
                    setConfirmation({
                      title: '撤销这个控制端？',
                      message: `${value.label || value.controllerUrl} 将立即失去管理本站的授权。本站用户、学习记录与其他控制端不受影响。`,
                      label: '确认撤销控制端',
                      run: () => revokeController(value.id),
                    })
                  }
                >
                  撤销授权
                </button>
              )}
            </article>
          ))}
        </div>
      </Panel>
      <AdminConfirm action={confirmation} onClose={() => setConfirmation(null)} />
    </div>
  );
}

function RemoteSiteAdmin({ site, onUpdated }: { site: FleetSite; onUpdated: () => void }) {
  const root = `admin/fleet/sites/${encodeURIComponent(site.id)}`;
  const [tab, setTab] = useState('settings');
  const [cursor, setCursor] = useState('');
  const canReadUsers = site.scopes.includes('users:read');
  const canWriteUsers = site.scopes.includes('users:write');
  const canWriteSettings = site.scopes.includes('settings:write');
  const canWriteAnnouncements = site.scopes.includes('announcements:write');
  const settings = useRemote<{ settings: { registrationOpen: boolean } }>(
    'fleet-site-settings',
    `${root}/settings`,
    true,
  );
  const users = useRemote<{
    items: FleetUser[];
    page: { nextCursor: string | null; hasMore: boolean };
  }>(
    'fleet-site-users',
    `${root}/users?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    canReadUsers && tab === 'users',
  );
  const announcements = useRemote<{ items: AdminAnnouncement[] }>(
    'fleet-site-announcements',
    `${root}/announcements`,
    canWriteAnnouncements && tab === 'announcements',
  );
  const [confirmation, setConfirmation] = useState<AdminConfirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<'published' | 'draft'>('published');
  const registrationOpen =
    settings.data?.settings.registrationOpen ?? site.lastSnapshot?.registrationOpen;
  const siteName = site.label || site.lastSnapshot?.site.title || site.remoteUrl;
  async function mutate(operation: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      setNotice(await operation());
      onUpdated();
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  async function toggleRegistration() {
    await mutate(async () => {
      await post(
        `${root}/settings`,
        { registrationOpen: !registrationOpen, commandId: newId() },
        'PATCH',
      );
      await settings.refetch();
      return `${siteName} 的注册已${registrationOpen ? '关闭' : '开放'}。`;
    });
  }
  async function toggleUser(value: FleetUser) {
    await mutate(async () => {
      await post(
        `${root}/users/${encodeURIComponent(value.id)}`,
        { disabled: !value.disabled, commandId: newId() },
        'PATCH',
      );
      await users.refetch();
      return `${value.name} 的目标站账号已${value.disabled ? '恢复' : '停用'}。`;
    });
  }
  async function createAnnouncement() {
    await mutate(async () => {
      await post(`${root}/announcements`, { title, body, status, commandId: newId() });
      setTitle('');
      setBody('');
      await announcements.refetch();
      return status === 'published' ? '目标站公告已发布。' : '目标站公告草稿已保存。';
    });
  }
  async function removeAnnouncement(value: AdminAnnouncement) {
    await mutate(async () => {
      await post(
        `${root}/announcements/${encodeURIComponent(value.id)}`,
        { commandId: newId() },
        'DELETE',
      );
      await announcements.refetch();
      return '目标站公告已移除。';
    });
  }
  return (
    <Panel className="admin-management-wide remote-site-admin">
      <div className="panel-title">
        <Network size={18} />
        <h2>管理 {siteName}</h2>
      </div>
      <p className="management-url">{site.remoteUrl}</p>
      <p className="fine-print">
        实例 {site.remoteInstanceId} · 站点 {site.remoteSiteId} · 以下操作在此目标站生效
      </p>
      <div className="tab-row small">
        {[
          { id: 'settings', label: '注册设置', enabled: true },
          { id: 'users', label: '用户', enabled: canReadUsers },
          { id: 'announcements', label: '公告', enabled: canWriteAnnouncements },
        ]
          .filter((value) => value.enabled)
          .map((value) => (
            <button
              key={value.id}
              className={tab === value.id ? 'active' : ''}
              onClick={() => setTab(value.id)}
            >
              {value.label}
            </button>
          ))}
      </div>
      <ErrorNotice error={error} />
      {notice && <Notice>{notice}</Notice>}
      {tab === 'settings' && (
        <>
          {settings.isPending && <Loading text="正在读取目标站设置…" />}
          <ErrorNotice error={settings.error} />
          <p>
            用户注册：
            {registrationOpen === undefined ? '尚未取得状态' : registrationOpen ? '开放' : '关闭'}
          </p>
          {canWriteSettings ? (
            <button
              className="button ghost"
              disabled={busy || settings.isFetching || !settings.data}
              onClick={() =>
                setConfirmation({
                  title: `${registrationOpen ? '关闭' : '开放'}目标站注册？`,
                  message: `将在 ${siteName} ${registrationOpen ? '关闭新用户注册；已有账号仍可继续登录。' : '开放新用户注册。'}`,
                  label: registrationOpen ? '确认关闭注册' : '确认开放注册',
                  run: toggleRegistration,
                })
              }
            >
              {registrationOpen ? '关闭注册' : '开放注册'}
            </button>
          ) : (
            <p className="fine-print">当前授权允许查看状态，修改注册开关需要目标站授予设置权限。</p>
          )}
        </>
      )}
      {tab === 'users' && (
        <>
          <div className="panel-title">
            <Users size={17} />
            <h3>目标站用户</h3>
          </div>
          <ErrorNotice error={users.error} />
          {users.isPending && <Loading text="正在读取目标站这一页用户…" />}
          {users.data?.items.length === 0 && <p className="fine-print">这一页没有用户。</p>}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>用户</th>
                  <th>邮箱</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.data?.items.map((value) => (
                  <tr key={value.id}>
                    <td>{value.name}</td>
                    <td>{value.email}</td>
                    <td>{value.role === 'admin' ? '管理员' : '用户'}</td>
                    <td>{value.disabled ? '停用' : '正常'}</td>
                    <td>
                      {canWriteUsers ? (
                        <button
                          className="button quiet"
                          disabled={busy}
                          onClick={() =>
                            setConfirmation({
                              title: value.disabled ? '恢复目标站用户？' : '停用目标站用户？',
                              message: `将在 ${siteName} ${value.disabled ? '恢复' : '停用'} ${value.name}（${value.email}）的账号。停用会撤销其目标站会话，学习记录会保留。`,
                              label: value.disabled ? '确认恢复' : '确认停用',
                              run: () => toggleUser(value),
                            })
                          }
                        >
                          {value.disabled ? '恢复' : '停用'}
                        </button>
                      ) : (
                        '仅查看'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination-actions">
            {cursor && (
              <button className="button ghost" disabled={busy} onClick={() => setCursor('')}>
                返回首屏
              </button>
            )}
            {users.data?.page.hasMore && users.data.page.nextCursor && (
              <button
                className="button ghost"
                disabled={busy}
                onClick={() => setCursor(users.data!.page.nextCursor!)}
              >
                下一页用户
              </button>
            )}
          </div>
        </>
      )}
      {tab === 'announcements' && (
        <div className="settings-grid">
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              setConfirmation({
                title: status === 'published' ? '发布目标站公告？' : '保存目标站公告草稿？',
                message: `将在 ${siteName} ${status === 'published' ? '发布' : '保存草稿'}“${title}”。`,
                label: status === 'published' ? '确认发布' : '确认保存草稿',
                run: createAnnouncement,
              });
            }}
          >
            <label className="field">
              标题
              <input
                required
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={160}
              />
            </label>
            <label className="field">
              正文
              <textarea
                required
                rows={5}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                maxLength={4000}
              />
            </label>
            <label className="field">
              状态
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as 'published' | 'draft')}
              >
                <option value="published">发布</option>
                <option value="draft">草稿</option>
              </select>
            </label>
            <button className="button primary" disabled={busy}>
              {status === 'published' ? '发布公告' : '保存草稿'}
            </button>
          </form>
          <div>
            <ErrorNotice error={announcements.error} />
            {announcements.isPending && <Loading text="正在读取目标站公告…" />}
            {announcements.data?.items.length === 0 && (
              <p className="fine-print">目标站还没有公告。</p>
            )}
            {announcements.data?.items.map((value) => (
              <article className="announcement-card" key={value.id}>
                <strong>{value.title}</strong>
                <span className="soft-badge">
                  {value.status === 'published' ? '已发布' : '草稿'}
                </span>
                <p>{value.body}</p>
                <button
                  className="button quiet"
                  disabled={busy}
                  onClick={() =>
                    setConfirmation({
                      title: '移除目标站公告？',
                      message: `将在 ${siteName} 移除“${value.title}”，目标站用户将无法继续查看这条公告。`,
                      label: '确认移除',
                      run: () => removeAnnouncement(value),
                    })
                  }
                >
                  移除公告
                </button>
              </article>
            ))}
          </div>
        </div>
      )}
      <AdminConfirm action={confirmation} onClose={() => setConfirmation(null)} />
    </Panel>
  );
}
