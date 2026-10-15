import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, BookOpen, ChevronRight, Plus, Star, TrendingUp } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import type { Book, PageInfo } from '../lib/types';
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

export function H5LearningPage() {
  const { user, pending } = useApp();
  const active = useScreenActive();
  const [params, setParams] = useSearchParams();
  const preferences = params.get('section') === 'preferences';
  const planning = useBookPlan();
  const plan = planning.query.data?.plan;
  const home = useRemote<H5HomeSummary>('app-home', 'app/home', !!user);
  const stats = useRemote<LearningStats>('stats', 'stats', !!user && !preferences);
  const books = useRemote<{ items: Book[] }>('books', 'books', !!user && !preferences);
  const wordbook = useRemote<{ page: PageInfo }>(
    'wordbook-summary',
    'wordbook?status=active&limit=1',
    !!user && !preferences,
  );
  const current = books.data?.items.find((item) => item.id === plan?.bookId);
  const phrases = books.data?.items.find(
    (item) => item.kind === 'phrases' && item.goal === current?.goal && !item.isDemo,
  );
  const [tasksOpen, setTasksOpen] = useState(false);
  const calendar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!active) return;
    if (params.get('section') === 'calendar' && home.data && !preferences)
      calendar.current?.scrollIntoView({ block: 'start' });
    if (params.get('section') === 'tasks') setTasksOpen(true);
  }, [params.get('section'), !!home.data, active]);
  if (!user)
    return (
      <div className="page h5-learning">
        <LoginPrompt />
      </div>
    );
  return (
    <div className="page h5-learning">
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
            <h2>计划</h2>
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
            <section className="h5-surface h5-learning-plan">
              <div className="h5-learning-books">
                <Link
                  className={`h5-plan-cover ${current?.kind === 'phrases' ? 'is-phrases' : ''}`}
                  to="/books"
                  aria-label={
                    current
                      ? `当前${current.kind === 'phrases' ? '词组本' : '词书'}：${current.title}，更换词书`
                      : '选择词书'
                  }
                >
                  <strong>{current ? goalLabels[current.goal] : '词书'}</strong>
                  <span>{current?.kind === 'phrases' ? '词组积累' : '词汇积累'}</span>
                  <i aria-hidden="true" />
                  <BookOpen size={18} aria-hidden="true" />
                </Link>
                <Link
                  className="h5-plan-phrase"
                  to={`/books?kind=phrases${current ? `&goal=${current.goal}` : ''}`}
                  aria-label={phrases ? `查看配套词组：${phrases.title}` : '选择配套词组本'}
                >
                  <span>配套词组</span>
                  <Plus size={24} />
                  <small>{current ? goalLabels[current.goal] : '更多表达'}</small>
                </Link>
                <div className="h5-plan-book-title">
                  <strong>{current?.title ?? plan?.bookTitle ?? '还没有选择词书'}</strong>
                  <span>
                    {current
                      ? `${current.wordCount.toLocaleString('zh-CN')} ${current.kind === 'phrases' ? '条词组' : '词'}`
                      : '选一本喜欢的书，定下每日目标。'}
                  </span>
                </div>
              </div>
              <Link className="h5-learning-wordbook" to="/wordbook">
                <Star size={19} />
                <span>生词本</span>
                <strong>{wordbook.data?.page.total ?? '—'}</strong>
                <ChevronRight size={16} />
              </Link>
              {current && (
                <>
                  <div
                    className="h5-plan-progress"
                    role="progressbar"
                    aria-label="当前词书已学习进度"
                    aria-valuemin={0}
                    aria-valuemax={current.wordCount}
                    aria-valuenow={current.learnedCount}
                  >
                    <i
                      style={{
                        width: `${current.wordCount ? Math.min(100, (current.learnedCount / current.wordCount) * 100) : 0}%`,
                      }}
                    />
                  </div>
                  <p className="h5-plan-progress-label">
                    已学习 {current.learnedCount.toLocaleString('zh-CN')} /{' '}
                    {current.wordCount.toLocaleString('zh-CN')}
                  </p>
                </>
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
              <p className="h5-caption h5-plan-rule">复习优先，再分配新词；同词当天只计一次。</p>
            </section>
          )}
          <ErrorNotice error={wordbook.error} onRetry={() => void wordbook.refetch()} />
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
                  {home.data && (
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

                  <TaskOverview plan={plan} pending={pending} compact />
                  <Link className="h5-learning-row" to="/learn">
                    <span>全部任务与同步</span>
                    <ArrowRight size={16} />
                  </Link>
                </div>
              )}
            </section>
          )}
          <div className="h5-section-label">
            <h2>统计</h2>
            <Link to="/memory">记忆曲线</Link>
          </div>
          <ErrorNotice error={stats.error} onRetry={() => void stats.refetch()} />
          <section className="h5-surface h5-learning-stats">
            <Link to="/memory" className="h5-stat-heading">
              <span>概览</span>
              <TrendingUp size={18} />
            </Link>
            {stats.isPending ? (
              <Loading />
            ) : (
              <div className="h5-learning-stat-grid">
                <div>
                  <span>今日已练习</span>
                  <strong>
                    {plan?.completedUnique ?? '—'}
                    <small>词</small>
                  </strong>
                </div>
                <div>
                  <span>累计已学</span>
                  <strong>
                    {stats.data?.totalLearned ?? '—'}
                    <small>词</small>
                  </strong>
                </div>
                <div>
                  <span>今日学习时长</span>
                  <strong>
                    {stats.data?.today.minutes ?? '—'}
                    <small>分钟</small>
                  </strong>
                </div>
                <div>
                  <span>累计复习</span>
                  <strong>
                    {stats.data?.totalReviews ?? '—'}
                    <small>次</small>
                  </strong>
                </div>
              </div>
            )}
          </section>
          <div className="h5-section-label">
            <h2>签到日历</h2>
            <span>{home.data?.checkedIn ? '今天已签到' : '完成学习自动记录'}</span>
          </div>
          <section className="h5-surface h5-learning-calendar" ref={calendar}>
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
          {planning.dialog}
        </>
      )}
    </div>
  );
}
