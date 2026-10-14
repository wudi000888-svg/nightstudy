import { ArrowRight, CalendarDays, Clock3, ListChecks, RotateCcw, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Plan, StudySession } from '../../lib/types';
import { Panel } from '../UI';
import type { TaskForecastResponse } from './types';
import './tasks.css';

export function taskLabel(session: StudySession) {
  return session.taskKind === 'extra-review'
    ? '额外复习'
    : session.taskKind === 'legacy'
      ? '此前已保存的学习组'
      : '今日任务';
}
export function taskDate(
  value: string | null | undefined,
  withTime = false,
  timeZone?: string | null,
) {
  if (!value) return '日期未记录';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '日期未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    ...(timeZone ? { timeZone } : {}),
    month: 'numeric',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date);
}

export function TaskOverview({
  plan,
  compact = false,
  pending = 0,
  onContinue,
  canContinue = true,
}: {
  plan: Plan;
  compact?: boolean;
  pending?: number;
  onContinue?: () => void;
  canContinue?: boolean;
}) {
  return (
    <div className={`task-overview ${compact ? 'compact' : ''}`}>
      <Panel className="task-today-card">
        <div className="section-heading">
          <span className="tiny-label">
            今日任务 · {plan.localDate} · {plan.timeZone}
          </span>
          <span className="soft-badge">
            <Clock3 size={12} /> {plan.dailyTotalGoal} 词 / 天
          </span>
        </div>
        <h3>
          <span>{plan.completedUnique}</span>
          <small> / {plan.dailyTotalGoal} 个不同词已评价</small>
        </h3>
        <div
          className="task-daily-progress"
          role="progressbar"
          aria-label="今日已评价不同词"
          aria-valuemin={0}
          aria-valuemax={Math.max(plan.dailyTotalGoal, plan.completedUnique)}
          aria-valuenow={plan.completedUnique}
        >
          <i
            style={{
              width: `${Math.min(100, (plan.completedUnique / plan.dailyTotalGoal) * 100)}%`,
            }}
          />
        </div>
        <p>
          已评价新学 {plan.completedNew} · 复习 {plan.completedReview}
          。同词的巩固与拼写不重复占每天总数。
        </p>
        <div className="task-plan-split">
          <span>
            <RotateCcw size={15} />
            计划复习 <strong>{plan.plannedReview}</strong>
          </span>
          <span>
            <Sparkles size={15} />
            计划新学 <strong>{plan.plannedNew}</strong>
          </span>
        </div>
        {onContinue ? (
          <button className="text-link" onClick={onContinue} disabled={!canContinue}>
            {plan.activeTaskId ? '继续已保存任务' : '查看今日任务'}
            <ArrowRight size={15} />
          </button>
        ) : (
          <Link
            className="text-link"
            to={
              plan.activeTaskId
                ? `/learn?session=${encodeURIComponent(plan.activeTaskId)}`
                : '/learn'
            }
          >
            {plan.activeTaskId ? '继续已保存任务' : '查看今日任务'}
            <ArrowRight size={15} />
          </Link>
        )}
      </Panel>
      <Panel className="task-queue-card">
        <div className="panel-title">
          <ListChecks size={19} />
          <h2>继续这一点积累</h2>
        </div>
        <div className="task-queue-metrics">
          <div>
            <span>待巩固</span>
            <strong>
              {plan.pendingConsolidationCount}
              <small>词</small>
            </strong>
          </div>
          <div>
            <span>待拼写</span>
            <strong>
              {plan.pendingSpellingCount}
              <small>词</small>
            </strong>
          </div>
          <div>
            <span>等待同步</span>
            <strong>
              {pending}
              <small>操作</small>
            </strong>
          </div>
        </div>
        <p>巩固与拼写可能涉及同一个词，数量不相加。等待同步的操作尚未算作服务端完成。</p>
        <div className="task-overdue">
          <Clock3 size={16} />
          <div>
            <strong>{plan.unplannedOverdueCount} 个逾期词尚未安排</strong>
            <small>今日额度优先给复习；不足部分继续保留，可主动安排额外复习。</small>
          </div>
        </div>
      </Panel>
    </div>
  );
}

export function TaskForecast({
  forecast,
  timeZone,
}: {
  forecast: TaskForecastResponse;
  timeZone?: string;
}) {
  const max = Math.max(1, ...forecast.days.map((day) => day.dueUnique + day.overdueCarry));
  return (
    <Panel className="task-forecast">
      <div className="section-heading">
        <div>
          <span className="tiny-label">接下来七天</span>
          <h2>
            <CalendarDays size={20} /> 复习负担，提前看清。
          </h2>
        </div>
        <span className="fine-print">{timeZone ?? '计划时区'} · 每日04:00交接</span>
      </div>
      <div className="task-forecast-days">
        {forecast.days.map((day, index) => (
          <div className="task-forecast-day" key={day.localDate}>
            <strong>{day.dueUnique + day.overdueCarry}</strong>
            <div className="task-forecast-bar">
              <i
                style={{
                  height: `${day.dueUnique + day.overdueCarry ? Math.max(5, ((day.dueUnique + day.overdueCarry) / max) * 100) : 0}%`,
                }}
              />
            </div>
            <span>{index === 0 ? '今天' : day.localDate.slice(5).replace('-', '/')}</span>
            <small>到期 {day.dueUnique}</small>
            <small>结转 {day.overdueCarry}</small>
          </div>
        ))}
      </div>
      <p className="fine-print">
        基于当前真实到期日期，假设后续尚未复习：当天到期与此前逾期结转互不重叠，同词可能出现在后续多天，不能跨日相加。后续评价会改变安排；图中不计未来新学词。
      </p>
    </Panel>
  );
}
