import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CalendarDays, ChevronDown } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import type { LearningStats } from '../lib/mobile-content-types';
import type { Plan } from '../lib/types';
import { ErrorNotice, Loading } from '../components/UI';
import { TaskOverview } from '../components/tasks/TaskOverview';

export function HomeLearning({ plan }: { plan: Plan | null }) {
  const { user, pending } = useApp();
  const [open, setOpen] = useState(false);
  const stats = useRemote<LearningStats>('stats', 'stats', !!user && open);
  const [selected, setSelected] = useState('');
  const day = stats.data?.trends.find((item) => item.date === selected) ?? stats.data?.today;
  const first = stats.data?.trends[0]?.date;
  const offset = first ? (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7 : 0;
  return (
    <section className="mobile-home-learning">
      <button
        className="mobile-disclosure"
        aria-expanded={open}
        aria-controls="home-learning-details"
        onClick={() => setOpen(!open)}
      >
        <span>
          <CalendarDays size={19} /> 我的学习
        </span>
        <span>
          {open ? '收起' : '计划 · 统计 · 日历'} <ChevronDown size={17} />
        </span>
      </button>
      {open && (
        <div id="home-learning-details" className="mobile-home-details">
          {!user ? (
            <p>
              登录后查看自己的计划、学习记录与日历。<Link to="/auth">登录 / 注册</Link>
            </p>
          ) : (
            <>
              {plan && <TaskOverview plan={plan} pending={pending} compact />}
              <ErrorNotice error={stats.error} onRetry={() => void stats.refetch()} />
              {stats.isPending && <Loading text="正在读取学习记录…" />}
              {stats.data && (
                <>
                  <div className="mobile-stat-strip">
                    <div>
                      <strong>{stats.data.totalLearned}</strong>
                      <span>累计已学词</span>
                    </div>
                    <div>
                      <strong>{stats.data.totalReviews}</strong>
                      <span>累计复习次数</span>
                    </div>
                    <div>
                      <strong>{stats.data.activeDays}</strong>
                      <span>满5分钟的学习日</span>
                    </div>
                  </div>
                  <div className="mobile-calendar">
                    <div className="mobile-section-title">
                      <h3>近30天记录</h3>
                      <span>{stats.data.timeZone} · 04:00 换日</span>
                    </div>
                    <div className="mobile-calendar-grid">
                      {['一', '二', '三', '四', '五', '六', '日'].map((label) => (
                        <span className="mobile-calendar-weekday" key={label}>
                          {label}
                        </span>
                      ))}
                      {Array.from({ length: offset }, (_, index) => (
                        <span key={`blank-${index}`} />
                      ))}
                      {stats.data.trends.map((item) => (
                        <button
                          key={item.date}
                          className={`${item.uniqueWords > 0 ? 'has-learning' : ''} ${item.checkedIn ? 'checked-in' : ''} ${day?.date === item.date ? 'selected' : ''}`}
                          aria-label={`${item.date}，练习${item.uniqueWords}词，${item.minutes}分钟`}
                          aria-pressed={day?.date === item.date}
                          onClick={() => setSelected(item.date)}
                        >
                          {Number(item.date.slice(-2))}
                          <i />
                        </button>
                      ))}
                    </div>
                    {day && (
                      <p className="mobile-caption">
                        {day.date}：已评价 {day.uniqueWords} 个不同词，新学 {day.newWords}，复习{' '}
                        {day.reviews} 次，{day.minutes} 分钟。
                        {day.checkedIn ? '当日已满5分钟。' : ''}
                      </p>
                    )}
                    {stats.data.dataLimited && (
                      <p className="mobile-caption">记录较多，日历按服务端最近可统计记录展示。</p>
                    )}
                  </div>
                </>
              )}
              <div className="mobile-inline-links">
                <Link to="/me?section=plan">
                  调整计划 <ArrowRight size={14} />
                </Link>
                <Link to="/memory">
                  记忆曲线与更多统计 <ArrowRight size={14} />
                </Link>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
