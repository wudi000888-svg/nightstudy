import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Dialog, ErrorNotice, Panel } from '../UI';
import { taskDate } from './TaskOverview';
import './tasks.css';

export interface TaskSyncConflict {
  id: string;
  createdAt: string;
  code: string;
  sessionId: string | null;
  action: 'reveal' | 'rate' | 'answer' | 'unknown';
}
const labels = { reveal: '揭晓释义', rate: '回忆评分', answer: '拼写提交', unknown: '学习操作' };

export function TaskConflicts({
  conflicts,
  onDiscard,
  onRead,
  busy,
  timeZone,
}: {
  conflicts: TaskSyncConflict[];
  onDiscard: (conflict: TaskSyncConflict) => Promise<void>;
  onRead: (sessionId: string) => Promise<void>;
  busy: boolean;
  timeZone?: string;
}) {
  const [selected, setSelected] = useState<TaskSyncConflict | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (selected && !conflicts.some((row) => row.id === selected.id)) setSelected(null);
  }, [conflicts, selected]);
  if (!conflicts.length) return null;
  return (
    <Panel className="task-conflict-card">
      <div className="panel-title">
        <AlertTriangle size={20} />
        <h2>{conflicts.length} 条本地操作与服务器状态冲突</h2>
      </div>
      <p>
        这些操作未被接受，服务器已有记录保留。可先读取最新任务，再逐条决定是否放弃冲突操作；其他待同步记录不会被清除。
      </p>
      <ErrorNotice error={error} />
      <div className="task-history-list">
        {conflicts.map((row) => (
          <div className="task-history-row" key={row.id}>
            <div>
              <strong>{labels[row.action]}</strong>
              {row.code === 'task_cancelled' && (
                <p>原任务已在切换词书后结束。这条本地操作尚未被接受，仍保留供你核对处理。</p>
              )}
              <small>
                {taskDate(row.createdAt, true, timeZone)} · {timeZone ?? '设备当地时间'} ·
                待处理同步冲突
              </small>
            </div>
            <div className="action-row">
              {row.sessionId && (
                <button
                  className="button ghost"
                  disabled={busy || discarding}
                  onClick={() => {
                    setError(null);
                    void onRead(row.sessionId!).catch(setError);
                  }}
                >
                  <RefreshCw size={14} />
                  {row.code === 'task_cancelled' ? '查看已结束任务' : '读取服务器任务'}
                </button>
              )}
              <button
                className="button quiet"
                disabled={busy || discarding}
                onClick={() => {
                  setError(null);
                  setSelected(row);
                }}
              >
                处理这一条
              </button>
            </div>
          </div>
        ))}
      </div>
      <Dialog
        open={!!selected}
        title="只放弃这条冲突的本地操作？"
        onClose={() => {
          if (!discarding) setSelected(null);
        }}
      >
        {selected && (
          <div className="form-stack">
            <p>放弃这条未被服务器接受的本地操作，保留服务器已接受记录，随后重新读取任务。</p>
            <p className="fine-print">
              操作：{labels[selected.action]} · {taskDate(selected.createdAt, true, timeZone)}（
              {timeZone ?? '设备当地时间'}）。只处理这一条，其余待同步操作保留。
            </p>
            <ErrorNotice error={error} />
            <div className="action-row">
              <button
                className="button primary"
                disabled={discarding || busy}
                onClick={() => {
                  const row = selected;
                  setDiscarding(true);
                  setError(null);
                  void onDiscard(row)
                    .then(() => setSelected(null))
                    .catch(setError)
                    .finally(() => setDiscarding(false));
                }}
              >
                {discarding ? '正在处理这一条…' : '确认放弃这条本地操作'}
              </button>
              <button
                className="button quiet"
                disabled={discarding}
                onClick={() => setSelected(null)}
              >
                保留，稍后处理
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </Panel>
  );
}
