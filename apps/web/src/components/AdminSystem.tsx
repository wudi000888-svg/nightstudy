import { useState } from 'react';
import { RefreshCw, Settings2 } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { post } from '../lib/api';
import type { AdminSystemInfo, SystemUpdate } from '../lib/types';
import { AdminUpdateStatus } from './AdminTools';
import { ErrorNotice, Loading, Panel } from './UI';

export function AdminSystem() {
  const { site } = useApp();
  const system = useRemote<AdminSystemInfo>('admin-system', 'admin/system');
  const [checked, setChecked] = useState<SystemUpdate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const update = checked ?? system.data?.update;
  async function check() {
    setBusy(true);
    setError(null);
    try {
      const result = await post<{ update: SystemUpdate }>('admin/system/check-update', {});
      setChecked(result.update);
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="admin-management-grid">
      <Panel>
        <div className="panel-title">
          <Settings2 size={18} />
          <h2>本站系统</h2>
        </div>
        <span className="fine-print">当前运行版本</span>
        <div className="system-version">{system.data?.version ?? site.version}</div>
        {system.isPending && <Loading text="正在读取系统信息…" />}
        <ErrorNotice error={system.error} />
        {system.data && (
          <dl className="system-facts">
            <div>
              <dt>站点</dt>
              <dd>{system.data.siteId}</dd>
            </div>
            <div>
              <dt>实例</dt>
              <dd>{system.data.instanceId}</dd>
            </div>
            <div>
              <dt>初始化</dt>
              <dd>{system.data.initialized ? '已完成' : '待完成'}</dd>
            </div>
            <div>
              <dt>用户注册</dt>
              <dd>{system.data.registrationOpen ? '开放' : '关闭'}</dd>
            </div>
          </dl>
        )}
        <p className="fine-print">
          安装时生成的管理员密码保存在部署服务器。网页不会回传或重新显示该密码。
        </p>
      </Panel>
      <Panel>
        <h2>检查发布更新</h2>
        <p>检测项目发布版本，查看更新说明后再安排服务器升级。</p>
        {update && <AdminUpdateStatus value={update} />}
        <ErrorNotice error={error} />
        <div className="action-row">
          <button
            className="button primary"
            disabled={busy || system.isPending}
            onClick={() => void check()}
          >
            <RefreshCw size={16} className={busy ? 'spin' : ''} />
            {busy ? '正在检测…' : '手动检测更新'}
          </button>
        </div>
      </Panel>
    </div>
  );
}
