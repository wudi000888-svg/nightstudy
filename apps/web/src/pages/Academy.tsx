import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Headphones, Mic, BookOpen, Layers } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { useLearningPreferences } from '../LearningPreferences';
import { api, mountUrl, newId, post } from '../lib/api';
import type {
  AcademyAttempt,
  AcademyCategory,
  AcademyLesson,
  LessonSummary,
} from '../lib/mobile-content-types';
import type { PageInfo } from '../lib/types';
import { Empty, ErrorNotice, Loading, LoginPrompt, Notice } from '../components/UI';
import { InteractiveEnglish } from '../components/InteractiveEnglish';
import { ReadAloudRecorder } from './ReadAloudRecorder';
import { usePageLifetime } from './usePageLifetime';
import './mobile-content.css';

const categories = [
  { value: 'all', label: '全部', icon: Layers },
  { value: 'listening', label: '听力', icon: Headphones },
  { value: 'shadowing', label: '跟读', icon: Mic },
  { value: 'reading', label: '短文', icon: BookOpen },
  { value: 'topic', label: '专题', icon: Layers },
] as const;
const categoryName = (kind: string) =>
  categories.find((item) => item.value === kind)?.label ?? '练习';
export function AcademyPage() {
  const { user } = useApp(),
    { preferences } = useLearningPreferences();
  const [params, setParams] = useSearchParams();
  const owner = usePageLifetime(`${params.get('lesson') ?? ''}:${params.get('attempt') ?? ''}`),
    client = useQueryClient();
  const category = params.get('tab') ?? 'all',
    requestedAttempt = params.get('attempt') ?? '';
  const [attempt, setAttempt] = useState<AcademyAttempt | null>(null),
    [answers, setAnswers] = useState<Record<string, string>>({});
  const [accent, setAccent] = useState<'us' | 'uk'>(preferences.accent),
    [showChinese, setShowChinese] = useState(true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState('');
  const saving = useRef(false),
    startCommand = useRef<{ key: string; id: string } | null>(null),
    submitCommand = useRef<{ key: string; id: string } | null>(null);
  const catalog = useRemote<{ items: LessonSummary[] }>('academy', 'academy', !!user);
  const savedAttempt = useRemote<{ attempt: AcademyAttempt }>(
    'academy-attempt',
    `academy/attempts/${encodeURIComponent(requestedAttempt)}`,
    !!user && !!requestedAttempt,
  );
  const lessonId = savedAttempt.data?.attempt.lessonId ?? params.get('lesson') ?? '';
  const details = useRemote<{ lesson: AcademyLesson }>(
    'academy-lesson',
    `academy/${encodeURIComponent(lessonId)}`,
    !!user && !!lessonId,
  );
  const history = useInfiniteQuery({
    queryKey: [owner.scope, 'academy-attempts', 'pages'],
    enabled: !!user && owner.active,
    retry: false,
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      api<{ items: AcademyAttempt[]; page: PageInfo }>(
        `academy/attempts?limit=15${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.page.hasMore ? (last.page.nextCursor ?? undefined) : undefined,
  });
  useEffect(() => {
    setAttempt((current) =>
      current?.id === requestedAttempt && current.lessonId === lessonId ? current : null,
    );
    setAnswers({});
    setError(null);
    setNotice('');
    setBusy(false);
    saving.current = false;
    startCommand.current = null;
    submitCommand.current = null;
  }, [owner.scope, lessonId, requestedAttempt]);
  useEffect(() => {
    if (savedAttempt.data?.attempt.id === requestedAttempt)
      setAttempt((current) =>
        current?.id === requestedAttempt && current.revision > savedAttempt.data!.attempt.revision
          ? current
          : savedAttempt.data!.attempt,
      );
  }, [savedAttempt.data, requestedAttempt]);
  useEffect(() => {
    if (!attempt) setAccent(preferences.accent);
  }, [preferences.accent]);
  const lesson =
    attempt?.lesson ??
    (requestedAttempt ? savedAttempt.data?.attempt.lesson : details.data?.lesson);
  const visible =
    catalog.data?.items.filter((item) => category === 'all' || item.category === category) ?? [];
  async function start() {
    if (!lesson || saving.current) return;
    const key = `${lesson.id}:${accent}`;
    if (startCommand.current?.key !== key) startCommand.current = { key, id: newId() };
    saving.current = true;
    setBusy(true);
    setError(null);
    const request = owner.capture();
    try {
      const result = await post<{ attempt: AcademyAttempt }>(
        `academy/${encodeURIComponent(lesson.id)}/attempts`,
        { commandId: startCommand.current.id, accent },
      );
      if (!owner.isCurrent(request)) return;
      startCommand.current = null;
      client.setQueryData(
        [owner.scope, 'academy-attempt', `academy/attempts/${result.attempt.id}`],
        result,
      );
      setAttempt(result.attempt);
      setAnswers({});
      if (owner.isForeground(request))
        setParams({ lesson: lesson.id, attempt: result.attempt.id }, { replace: true });
      await client.invalidateQueries({ queryKey: [owner.scope, 'academy-attempts'] });
    } catch (value) {
      if (owner.isCurrent(request)) setError(value);
    } finally {
      if (owner.isCurrent(request)) {
        saving.current = false;
        setBusy(false);
      }
    }
  }
  async function submit() {
    if (!attempt || saving.current) return;
    const body = {
      expectedRevision: attempt.revision,
      ...(attempt.kind === 'listening'
        ? {
            answers: attempt.items.map((item) => ({
              itemId: item.id,
              answer: answers[item.id] ?? '',
            })),
          }
        : {}),
    };
    const key = JSON.stringify([attempt.id, body]);
    if (submitCommand.current?.key !== key) submitCommand.current = { key, id: newId() };
    saving.current = true;
    setBusy(true);
    setError(null);
    const request = owner.capture();
    try {
      const result = await post<{ attempt: AcademyAttempt }>(
        `academy/attempts/${encodeURIComponent(attempt.id)}/submit`,
        { commandId: submitCommand.current.id, ...body },
      );
      if (!owner.isCurrent(request)) return;
      client.setQueryData(
        [owner.scope, 'academy-attempt', `academy/attempts/${result.attempt.id}`],
        result,
      );
      setAttempt(result.attempt);
      submitCommand.current = null;
      setNotice('本次练习已保存。');
      await Promise.all([
        client.invalidateQueries({ queryKey: [owner.scope, 'academy'] }),
        client.invalidateQueries({ queryKey: [owner.scope, 'academy-attempts'] }),
      ]);
    } catch (value) {
      if (owner.isCurrent(request)) setError(value);
    } finally {
      if (owner.isCurrent(request)) {
        saving.current = false;
        setBusy(false);
      }
    }
  }
  async function reloadAttempt() {
    if (!attempt || saving.current) return;
    const request = owner.capture();
    try {
      const result = await api<{ attempt: AcademyAttempt }>(
        `academy/attempts/${encodeURIComponent(attempt.id)}`,
      );
      if (owner.isCurrent(request)) {
        client.setQueryData(
          [owner.scope, 'academy-attempt', `academy/attempts/${result.attempt.id}`],
          result,
        );
        setAttempt(result.attempt);
        setError(null);
      }
    } catch (value) {
      if (owner.isCurrent(request)) setError(value);
    }
  }
  if (!user)
    return (
      <div className="page">
        <LoginPrompt />
      </div>
    );
  return (
    <div className="page mobile-academy">
      <Link className="mobile-back" to={lessonId ? '/academy' : '/content'}>
        ← {lessonId ? '返回学堂' : '内容中心'}
      </Link>
      <header className="mobile-content-heading">
        <span className="mobile-kicker">ENGLISH ACADEMY</span>
        <h1>{lesson?.title ?? '英语学堂'}</h1>
        <p>{lesson?.description ?? '听一点，读一段，再把英语放进自己的声音里。'}</p>
      </header>
      <ErrorNotice error={error || details.error || savedAttempt.error || catalog.error} />
      {notice && <Notice>{notice}</Notice>}
      {lessonId ? (
        (requestedAttempt ? savedAttempt.isPending : details.isPending) ? (
          <Loading text="正在打开短课…" />
        ) : (
          lesson && (
            <>
              <div className="mobile-toolbar">
                <span>
                  {categoryName(lesson.category)} · {lesson.durationMinutes}分钟 ·{' '}
                  {lesson.level === 'starter' ? '入门' : '基础'}
                </span>
                <button
                  className="text-link"
                  aria-pressed={showChinese}
                  onClick={() => setShowChinese(!showChinese)}
                >
                  {showChinese ? '隐藏中文' : '显示中文'}
                </button>
              </div>
              {lesson.body.length > 0 && (
                <section className="mobile-lesson-body">
                  {lesson.body.map((paragraph) => (
                    <div key={paragraph.id}>
                      <p lang="en">
                        <InteractiveEnglish text={paragraph.en} />
                      </p>
                      {showChinese && <p lang="zh">{paragraph.zh}</p>}
                    </div>
                  ))}
                </section>
              )}
              {lesson.vocabulary.length > 0 && (
                <div className="mobile-lesson-vocabulary">
                  {lesson.vocabulary.map((word) => (
                    <span key={word}>
                      <InteractiveEnglish text={word} />
                    </span>
                  ))}
                </div>
              )}
              {lesson.category === 'shadowing' && (
                <ReadAloudRecorder
                  key={`${owner.scope}:${lesson.id}`}
                  text={lesson.body.map((item) => item.en).join(' ')}
                  accent={accent}
                />
              )}
              {(!attempt || attempt.result) && (
                <div className="mobile-choice-row" aria-label="本次练习默认口音">
                  {(['us', 'uk'] as const).map((value) => (
                    <button
                      key={value}
                      aria-pressed={accent === value}
                      className={accent === value ? 'selected' : ''}
                      onClick={() => setAccent(value)}
                    >
                      {value === 'us' ? '美式英语' : '英式英语'}
                    </button>
                  ))}
                </div>
              )}
              {!attempt && (
                <>
                  <button
                    className="button primary full"
                    disabled={
                      busy || (lesson.category === 'listening' && lesson.audioAvailable === false)
                    }
                    onClick={() => void start()}
                  >
                    {busy
                      ? '正在准备…'
                      : lesson.category === 'listening'
                        ? '开始听力练习'
                        : '开始本次练习'}
                    <ArrowRight size={17} />
                  </button>
                  {lesson.category === 'listening' && lesson.audioAvailable === false && (
                    <p className="mobile-caption">
                      本课所需的英美音源尚未全部就绪，请选择其他短课。
                    </p>
                  )}
                </>
              )}
              {attempt && (
                <>
                  {attempt.kind === 'listening' &&
                    attempt.items.map((item, index) => {
                      const feedback = attempt.result?.feedback.find(
                        (value) => value.itemId === item.id,
                      );
                      return (
                        <section className="mobile-listening-question" key={item.id}>
                          <h3>
                            {index + 1}. {item.prompt}
                          </h3>
                          <audio controls preload="none" src={mountUrl(item.audioUrl)} />
                          <fieldset
                            className="mobile-answer-options"
                            disabled={!!attempt.result || busy}
                          >
                            <legend className="sr-only">第{index + 1}题选项</legend>
                            {item.options.map((option) => (
                              <label
                                key={option.id}
                                className={answers[item.id] === option.id ? 'selected' : ''}
                              >
                                <input
                                  type="radio"
                                  name={`${attempt.id}:${item.id}`}
                                  value={option.id}
                                  checked={answers[item.id] === option.id}
                                  onChange={() => setAnswers({ ...answers, [item.id]: option.id })}
                                />
                                {option.text}
                              </label>
                            ))}
                          </fieldset>
                          {feedback && (
                            <p className="mobile-caption">
                              {feedback.correct
                                ? '回答正确。'
                                : `本题正确答案：${feedback.correctAnswer}`}
                            </p>
                          )}
                        </section>
                      );
                    })}
                  {attempt.result ? (
                    <section className="mobile-practice-result">
                      <CheckCircle2 size={25} />
                      <h2>本次练习已完成</h2>
                      {attempt.result.assessmentKind === 'objective-listening' ? (
                        <p>
                          答对 {attempt.result.correct} / {attempt.result.total} 题，得分{' '}
                          {attempt.result.score}%。
                        </p>
                      ) : (
                        <p>
                          已保存本次{categoryName(attempt.kind)}的完成记录，本课不提供能力分数。
                        </p>
                      )}
                      <button
                        className="button ghost"
                        disabled={busy}
                        onClick={() => {
                          setAttempt(null);
                          setAnswers({});
                          setParams({ lesson: lesson.id }, { replace: true });
                        }}
                      >
                        再练一次
                      </button>
                    </section>
                  ) : (
                    <>
                      <button
                        className="button primary full"
                        disabled={
                          busy ||
                          (attempt.kind === 'listening' &&
                            attempt.items.some((item) => !answers[item.id]))
                        }
                        onClick={() => void submit()}
                      >
                        {busy
                          ? '正在保存…'
                          : attempt.kind === 'listening'
                            ? '提交本组答案'
                            : '记录本次练习完成'}
                      </button>
                      <button
                        className="text-link"
                        disabled={busy}
                        onClick={() => void reloadAttempt()}
                      >
                        读取服务器最新练习状态
                      </button>
                    </>
                  )}
                </>
              )}
              <p className="mobile-caption">完成短课会留下练习记录，词书仍按原来的计划学习。</p>
            </>
          )
        )
      ) : (
        <>
          <nav className="mobile-academy-tabs" aria-label="学堂分类">
            {categories.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                className={category === value ? 'selected' : ''}
                aria-pressed={category === value}
                onClick={() => setParams(value === 'all' ? {} : { tab: value })}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </nav>
          {catalog.isPending ? (
            <Loading />
          ) : visible.length ? (
            <div className="mobile-lesson-grid">
              {visible.map((item) => (
                <Link
                  to={`/academy?lesson=${encodeURIComponent(item.id)}`}
                  className="mobile-lesson-card"
                  key={item.id}
                >
                  <div className="mobile-lesson-label">
                    <span>
                      {categoryName(item.category)} · {item.level === 'starter' ? '入门' : '基础'}
                    </span>
                    <span>{item.durationMinutes}分钟</span>
                  </div>
                  <h2>{item.title}</h2>
                  <p>{item.description}</p>
                  <span>
                    {item.completedAttempts ? `已完成 ${item.completedAttempts} 次` : '打开短课'} →
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <Empty title="这个分类暂时没有短课" description="选择其他分类，或稍后再来。" />
          )}
          <p className="mobile-caption">
            入门短课供日常练习，不是完整考试课程。听力使用本站已有单词音源；跟读的设备声音取决于浏览器和系统。
          </p>
          <section>
            <h2 className="mobile-group-heading">我的练习记录</h2>
            <ErrorNotice error={history.error} onRetry={() => void history.refetch()} />
            {history.isPending ? (
              <Loading />
            ) : history.data?.pages.some((page) => page.items.length) ? (
              history.data.pages
                .flatMap((page) => page.items)
                .map((item) => (
                  <Link
                    className="mobile-attempt-row"
                    to={`/academy?lesson=${encodeURIComponent(item.lessonId)}&attempt=${encodeURIComponent(item.id)}`}
                    key={item.id}
                  >
                    <span>
                      {catalog.data?.items.find((lesson) => lesson.id === item.lessonId)?.title ??
                        '短课练习'}
                      <small>
                        {new Intl.DateTimeFormat('zh-CN', {
                          month: 'numeric',
                          day: 'numeric',
                        }).format(new Date(item.startedAt))}{' '}
                        · {categoryName(item.kind)}
                      </small>
                    </span>
                    <span>
                      {item.completedAt ? '已完成' : '继续练习'} <ArrowRight size={14} />
                    </span>
                  </Link>
                ))
            ) : (
              <p className="mobile-caption">开始一节短课，完成记录会留在这里。</p>
            )}
            {history.hasNextPage && (
              <button
                className="button ghost full"
                disabled={history.isFetchingNextPage}
                onClick={() => {
                  if (owner.active) void history.fetchNextPage();
                }}
              >
                更多记录
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
