import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarDays,
  ChevronRight,
  TrendingUp,
} from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import type { Book } from '../lib/types';
import type { H5HomeSummary } from '../lib/h5-home-types';
import type { LearningStats } from '../lib/mobile-content-types';
import { useScreenActive } from '../lib/screen-lifecycle';
import { PwaSettings } from '../components/Pwa';
import { goalLabels } from '../lib/types';
import { ErrorNotice, Loading, LoginPrompt } from '../components/UI';
import { TaskOverview, taskDate } from '../components/tasks/TaskOverview';
import { useBookPlan } from '../components/tasks/useBookPlan';
import { PreferencesSettings } from './PreferencesSettings';
import { LearningCalendar } from './HomeLearning';
import './mobile-content.css';
import './h5-home.css';
import './learning-refinement.css';

export function H5LearningPage() {
  const { user, pending, conflicts } = useApp();
  const active = useScreenActive();
  const [params, setParams] = useSearchParams();
  const section = params.get('section');
  const preferences = section === 'preferences';
  const detail = section === 'stats' || section === 'calendar';
  const planning = useBookPlan();
  const plan = planning.query.data?.plan;
  const home = useRemote<H5HomeSummary>('app-home', 'app/home', !!user && !preferences);
  const stats = useRemote<LearningStats>('stats', 'stats', !!user && section === 'stats');
  const books = useRemote<{ items: Book[] }>('books', 'books', !!user && !preferences && !detail);
  const current = books.data?.items.find((item) => item.id === plan?.bookId);
  const phrases =
    current?.kind !== 'phrases'
      ? books.data?.items.find(
          (item) => item.kind === 'phrases' && item.goal === current?.goal && !item.isDemo,
        )
      : undefined;
  const [tasksOpen, setTasksOpen] = useState(false);
  const [trendDays, setTrendDays] = useState<7 | 30>(7);
  useEffect(() => {
    if (active && section === 'tasks') setTasksOpen(true);
  }, [section, active]);
  if (!user)
    return (
      <div className="page h5-learning">
        <LoginPrompt />
      </div>
    );

  if (detail) {
    const days = stats.data?.trends.slice(-trendDays) ?? [];
    const maxWords = Math.max(1, ...days.map((day) => day.newWords + day.reviewWords));
    return (
      <div className="page h5-learning h5-learning-detail">
        <Link className="learning-detail-back" to="/learning">
          <ArrowLeft size={18} /> 返回我的学习
        </Link>
        <header className="learning-detail-heading">
          <h2>{section === 'calendar' ? '学习日历' : '学习统计'}</h2>
          <p>
            {section === 'calendar' ? '每次认真学习，都留下一点积累。' : '看看自己的学习节奏。'}
          </p>
        </header>
        {section === 'calendar' ? (
          <section className="h5-surface h5-learning-calendar">
            <ErrorNotice error={home.error} onRetry={() => void home.refetch()} />
            {home.isPending ? (
              <Loading text="正在读取学习日历…" />
            ) : (
              home.data && (
                <LearningCalendar
                  calendar={home.data.calendar}
                  localDate={home.data.localDate}
                  timeZone={home.data.timeZone}
                />
              )
            )}
          </section>
        ) : (
          <>
            <ErrorNotice error={stats.error} onRetry={() => void stats.refetch()} />
            {stats.isPending ? (
              <Loading text="正在读取学习统计…" />
            ) : (
              stats.data && (
                <>
                  <section className="h5-surface h5-learning-stats">
                    <div className="h5-learning-stat-grid">
                      <div>
                        <span>今日已练习</span>
                        <strong>
                          {stats.data.today.uniqueWords}
                          <small>词</small>
                        </strong>
                      </div>
                      <div>
                        <span>累计已学</span>
                        <strong>
                          {stats.data.totalLearned}
                          <small>词</small>
                        </strong>
                      </div>
                      <div>
                        <span>今日学习时长</span>
                        <strong>
                          {stats.data.today.minutes}
                          <small>分钟</small>
                        </strong>
                      </div>
                      <div>
                        <span>累计复习</span>
                        <strong>
                          {stats.data.totalReviews}
                          <small>次</small>
                        </strong>
                      </div>
                    </div>
                  </section>
                  <section className="h5-surface learning-trends" aria-label="学习量趋势">
                    <div className="learning-trends-heading">
                      <h3>每日词量</h3>
                      <div role="group" aria-label="统计范围">
                        {([7, 30] as const).map((count) => (
                          <button
                            type="button"
                            aria-pressed={trendDays === count}
                            onClick={() => setTrendDays(count)}
                            key={count}
                          >
                            {count === 7 ? '近一周' : '近一月'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <p className="learning-trend-legend">
                      <span>新学</span>
                      <span>复习</span>
                    </p>
                    {days.some((day) => day.newWords || day.reviewWords) ? (
                      <ol className="learning-trend-list">
                        {days.map((day) => (
                          <li key={day.date}>
                            <time dateTime={day.date}>{day.date.slice(5).replace('-', '/')}</time>
                            <span className="learning-trend-bar" aria-hidden="true">
                              <i style={{ width: `${(day.newWords / maxWords) * 100}%` }} />
                              <i style={{ width: `${(day.reviewWords / maxWords) * 100}%` }} />
                            </span>
                            <span
                              className="learning-trend-value"
                              aria-label={`新学${day.newWords}词，复习${day.reviewWords}词`}
                            >
                              {day.newWords} / {day.reviewWords}
                            </span>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="h5-caption learning-detail-empty">
                        还没有已保存的学习记录，完成一组后再来看看。
                      </p>
                    )}
                    <p className="h5-caption">每日词数按不同单词统计；累计复习统计实际评价次数。</p>
                    {stats.data.dataLimited && (
                      <p className="h5-caption">当前记录较多，本页显示已统计的范围。</p>
                    )}
                  </section>
                </>
              )
            )}
          </>
        )}
      </div>
    );
  }
  return (
    <div className="page h5-learning h5-learning-refined">
      <nav className="h5-learning-segments" aria-label="学习设置分类">
        <button type="button" aria-pressed={!preferences} onClick={() => setParams({})}>
          我的学习
        </button>
        <button
          type="button"
          aria-pressed={preferences}
          onClick={() => setParams({ section: 'preferences' })}
        >
          学习偏好
        </button>
      </nav>
      {preferences ? (
        <section className="h5-surface h5-preferences">
          <PreferencesSettings />
          <PwaSettings />
        </section>
      ) : (
        <>
          <div className="h5-section-label">
            <h2>当前计划</h2>
            <Link to="/books">换本词书</Link>
          </div>
          <ErrorNotice
            error={planning.query.error || books.error}
            onRetry={() => {
              void planning.query.refetch();
              void books.refetch();
            }}
          />
          {planning.query.isPending ? (
            <Loading text="正在读取学习计划…" />
          ) : (
            <section className="h5-surface h5-learning-plan learning-plan-summary">
              <div className="learning-plan-book">
                <Link
                  className={`h5-plan-cover ${current?.kind === 'phrases' ? 'is-phrases' : ''}`}
                  to={
                    current
                      ? `/library?bookId=${encodeURIComponent(current.id)}&view=all`
                      : '/books'
                  }
                  aria-label={current ? `查看${current.title}词表` : '选择词书'}
                >
                  <strong>{current ? goalLabels[current.goal] : '词书'}</strong>
                  <span>{current?.kind === 'phrases' ? '词组积累' : '词汇积累'}</span>
                  <i aria-hidden="true" />
                  <BookOpen size={18} aria-hidden="true" />
                </Link>
                <div className="learning-plan-book-copy">
                  <strong>{current?.title ?? plan?.bookTitle ?? '还没有选择词书'}</strong>
                  <span>
                    {current
                      ? `已学 ${current.learnedCount.toLocaleString('zh-CN')} / ${current.wordCount.toLocaleString('zh-CN')} ${current.kind === 'phrases' ? '条词组' : '词'}`
                      : '选一本喜欢的书，定下每日目标。'}
                  </span>
                  {current && (
                    <div
                      className="h5-plan-progress"
                      role="progressbar"
                      aria-label="当前词书已学习进度"
                      aria-valuemin={0}
                      aria-valuemax={Math.max(1, current.wordCount)}
                      aria-valuenow={current.learnedCount}
                    >
                      <i
                        style={{
                          width: `${current.wordCount ? Math.min(100, (current.learnedCount / current.wordCount) * 100) : 0}%`,
                        }}
                      />
                    </div>
                  )}
                  {phrases && (
                    <Link
                      className="learning-plan-companion"
                      to={`/books?kind=phrases&goal=${current?.goal}`}
                    >
                      <span>配套词组 · {phrases.title}</span>
                      <ChevronRight size={14} />
                    </Link>
                  )}
                </div>
              </div>
              {plan && (
                <div className="learning-plan-today" aria-label="今日学习安排">
                  <div>
                    <span>今日已完成</span>
                    <strong>
                      {plan.completedUnique}
                      <small> / {plan.dailyTotalGoal}</small>
                    </strong>
                  </div>
                  <div>
                    <span>待复习</span>
                    <strong>{Math.max(0, plan.plannedReview - plan.completedReview)}</strong>
                  </div>
                  <div>
                    <span>待新学</span>
                    <strong>{Math.max(0, plan.plannedNew - plan.completedNew)}</strong>
                  </div>
                </div>
              )}
              {current ? (
                <button
                  type="button"
                  className="h5-plan-goal"
                  onClick={() => planning.choose(current)}
                >
                  <span>
                    每日总目标 <strong>{plan?.dailyTotalGoal ?? '—'}</strong> 词
                  </span>
                  <span>
                    调整 <ChevronRight size={15} />
                  </span>
                </button>
              ) : (
                <Link className="h5-plan-goal" to="/books">
                  <span>选择词书与每日目标</span>
                  <ChevronRight size={17} />
                </Link>
              )}
              <details className="learning-plan-rules">
                <summary>复习优先，同词当天只计一次</summary>
                <p>
                  每天先安排到期复习，新词使用剩余额度。重复巩固和拼写不重复占用每日词数，已保存的学习记录一直保留。
                </p>
              </details>
            </section>
          )}
          {plan && (
            <section className="h5-surface h5-today-detail">
              <button
                type="button"
                className="h5-learning-row"
                aria-expanded={tasksOpen}
                aria-controls="h5-today-tasks"
                onClick={() => setTasksOpen(!tasksOpen)}
              >
                <span>
                  今日任务{' '}
                  <strong>
                    {plan.completedUnique} / {plan.dailyTotalGoal}
                  </strong>
                </span>
                <span>
                  {tasksOpen ? '收起' : '查看'} <ChevronRight size={16} />
                </span>
              </button>
              {tasksOpen && (
                <div id="h5-today-tasks">
                  {home.data &&
                    !home.isFetching &&
                    home.data.plan.bookId === plan.bookId &&
                    home.data.plan.revision === plan.revision && (
                      <div className="h5-task-state-note">
                        {home.data.dailyGoalComplete ? (
                          <p>今天的总目标已经完成。去日历看看这一步。</p>
                        ) : home.data.review.availableAt && home.data.review.state === 'waiting' ? (
                          <p>
                            现在暂时不用复习。下次安排：
                            {taskDate(home.data.review.availableAt, true, home.data.timeZone)}。
                          </p>
                        ) : home.data.learn.state === 'review_first' ? (
                          <p>先完成到期复习，再安排今天的新词。</p>
                        ) : home.data.learn.state === 'empty' &&
                          home.data.review.state === 'empty' ? (
                          <p>现在没有待学词，可以调整词书或查看记忆曲线。</p>
                        ) : null}
                        {pending > 0 && <p>{pending} 条记录等待同步，先核对已有任务再继续。</p>}
                      </div>
                    )}
                  {conflicts?.some((row) => row.code === 'task_cancelled') && (
                    <div className="h5-task-state-note">
                      <p>
                        原任务已在切书后结束，已保存记录保留。未保存的本地操作需要逐条核对处理。
                      </p>
                      <Link className="text-link" to="/learn">
                        处理旧任务的待同步操作 <ArrowRight size={15} />
                      </Link>
                    </div>
                  )}
                  <TaskOverview plan={plan} pending={pending} compact />
                  <Link className="h5-learning-row" to="/learn">
                    <span>全部任务与同步</span>
                    <ArrowRight size={16} />
                  </Link>
                </div>
              )}
            </section>
          )}
          <nav className="h5-list-group learning-detail-entries" aria-label="学习记录详情">
            <Link className="h5-list-row" to="/learning?section=stats">
              <TrendingUp size={20} />
              <span>学习统计</span>
              <ArrowRight size={16} />
            </Link>
            <Link className="h5-list-row" to="/learning?section=calendar">
              <CalendarDays size={20} />
              <span>学习日历</span>
              <ArrowRight size={16} />
            </Link>
            <Link className="h5-list-row" to="/memory">
              <TrendingUp size={20} />
              <span>记忆曲线</span>
              <ArrowRight size={16} />
            </Link>
          </nav>
          {planning.dialog}
        </>
      )}
    </div>
  );
}
