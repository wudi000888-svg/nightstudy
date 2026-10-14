import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Clock3, RotateCcw } from 'lucide-react';
import { goalLabels, goalNames, type Book } from '../lib/types';
import { useApp, useRemote } from '../AppContext';
import {
  Empty,
  ErrorNotice,
  Heading,
  Loading,
  LoginPrompt,
  Panel,
  formatDate,
} from '../components/UI';
interface CurvePoint {
  day: number;
  retention: number;
  lower: number;
  upper: number;
}
interface Observation {
  reviewedAt: string;
  rating: string;
  expectedRetrievability: number | null;
  remembered: boolean;
}
interface Curve {
  empty: boolean;
  asOf: string;
  coverage: { total: number; eligible: number };
  points: CurvePoint[];
  observations: Observation[];
  recallBins: { label: string; count: number; againRate: number | null }[];
  disclaimer: string;
}
interface Stats {
  today: {
    date: string;
    newWords: number;
    reviews: number;
    seconds: number;
    minutes: number;
    checkedIn: boolean;
  };
  totalLearned: number;
  totalReviews: number;
  knownClaimCount: number;
  activeDays: number;
  streak: number;
  trends: { date: string; newWords: number; reviews: number; seconds: number }[];
}
function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}
export function MemoryChart({ data, horizon }: { data: Curve; horizon: number }) {
  const points = data.points.filter(
    (point) =>
      point.day <= horizon && Number.isFinite(point.day) && Number.isFinite(point.retention),
  );
  const width = 720,
    height = 280,
    left = 48,
    top = 22,
    chartWidth = 645,
    chartHeight = 214;
  const x = (day: number) => left + (day / horizon) * chartWidth;
  const y = (value: number) => top + (1 - clamp(value)) * chartHeight;
  const line = points.map((point) => `${x(point.day)},${y(point.retention)}`).join(' ');
  const band = [
    ...points.map((point) => `${x(point.day)},${y(point.upper)}`),
    ...[...points].reverse().map((point) => `${x(point.day)},${y(point.lower)}`),
  ].join(' ');
  if (!points.length)
    return (
      <Empty
        title="这个范围暂时没有有效预测点。"
        description="完成学习和复习后，再来看看记忆的变化。"
      />
    );
  return (
    <svg
      className="memory-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`未来 ${horizon} 天不再复习时的记忆预测，基于 ${data.coverage.eligible} 个已学习的词`}
    >
      <defs>
        <linearGradient id="retention-band" x2="0" y2="1">
          <stop stopColor="#e9b36d" stopOpacity=".19" />
          <stop offset="1" stopColor="#e9b36d" stopOpacity=".03" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((value) => (
        <g key={value}>
          <line
            x1={left}
            x2={left + chartWidth}
            y1={y(value)}
            y2={y(value)}
            stroke="#f4eee5"
            strokeOpacity=".08"
          />
          <text x={left - 10} y={y(value) + 4} textAnchor="end">
            {Math.round(value * 100)}%
          </text>
        </g>
      ))}
      {[0, horizon / 4, horizon / 2, horizon * 0.75, horizon].map((day) => (
        <text key={day} x={x(day)} y={height - 16} textAnchor="middle">
          {Math.round(day)}天
        </text>
      ))}
      {data.coverage.eligible > 1 && <polygon points={band} fill="url(#retention-band)" />}
      <polyline
        points={line}
        fill="none"
        stroke="#e9b36d"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {points
        .filter((_, index) => index % Math.max(1, Math.floor(points.length / 7)) === 0)
        .map((point) => (
          <circle key={point.day} cx={x(point.day)} cy={y(point.retention)} r="3.5" fill="#e9b36d">
            <title>
              {point.day}天 · 预计回忆率 {Math.round(point.retention * 100)}%
            </title>
          </circle>
        ))}
    </svg>
  );
}
export function MemoryPage() {
  const { user } = useApp();
  const [selectedScope, setSelectedScope] = useState('all');
  const query = selectedScope.startsWith('book:')
    ? `?bookId=${encodeURIComponent(selectedScope.slice(5))}`
    : selectedScope.startsWith('goal:')
      ? `?goal=${selectedScope.slice(5)}`
      : '';
  const curve = useRemote<Curve>('memory', `memory/curve${query}`, !!user);
  const stats = useRemote<Stats>('stats', 'stats', !!user);
  const books = useRemote<{ items: Book[] }>('books', 'books', !!user);
  const [horizon, setHorizon] = useState(30);
  if (!user)
    return (
      <div className="page">
        <LoginPrompt />
      </div>
    );
  const data = curve.data;
  return (
    <div className="page">
      <Heading
        eyebrow="个人记忆 · 看清一点自己的节奏"
        title={
          <>
            记住的每一点，<em>都有下一次。</em>
          </>
        }
        description="根据你的本站学习记录预测未来记忆，并展示真实回忆反馈。"
      />
      <label className="field memory-scope">
        查看范围
        <select value={selectedScope} onChange={(event) => setSelectedScope(event.target.value)}>
          <option value="all">本站全部已学词</option>
          {goalNames.map((goal) => (
            <option key={goal} value={`goal:${goal}`}>
              {goalLabels[goal]} · 已学词
            </option>
          ))}
          {books.data?.items.map((book) => (
            <option key={book.id} value={`book:${book.id}`}>
              {book.title}
            </option>
          ))}
        </select>
      </label>
      <ErrorNotice
        error={curve.error || stats.error}
        onRetry={() => {
          void curve.refetch();
          void stats.refetch();
        }}
      />
      {stats.data && (
        <div className="four-metrics">
          <Panel className="metric">
            <span>今日新学</span>
            <strong>
              {stats.data.today.newWords}
              <small>词</small>
            </strong>
            <p>首次学习发生在今天</p>
          </Panel>
          <Panel className="metric">
            <span>今日复习</span>
            <strong>
              {stats.data.today.reviews}
              <small>次</small>
            </strong>
            <p>与首次学习分开统计</p>
          </Panel>
          <Panel className="metric">
            <span>学过的词</span>
            <strong>{stats.data.totalLearned}</strong>
            <p>同词只计一次</p>
          </Panel>
          <Panel className="metric">
            <span>连续达标</span>
            <strong>
              {stats.data.streak}
              <small>天</small>
            </strong>
            <p>以本站实际记录为准</p>
          </Panel>
        </div>
      )}
      <Panel className="curve-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">记忆预测 · 如果不再复习</span>
            <h2>未来的记忆，先有一个参考。</h2>
          </div>
          <div className="tab-row small">
            <button className={horizon === 7 ? 'active' : ''} onClick={() => setHorizon(7)}>
              7天
            </button>
            <button className={horizon === 30 ? 'active' : ''} onClick={() => setHorizon(30)}>
              30天
            </button>
          </div>
        </div>
        {curve.isPending ? (
          <Loading text="正在打开你的记忆曲线…" />
        ) : !data || data.empty ? (
          <Empty
            title="你的曲线，还需要一点真实记录。"
            description="先完成学习和复习。只有导入的熟词，还不足以生成记忆预测。"
            action={
              <Link className="button primary" to="/learn">
                开始一组学习 <ArrowRight size={16} />
              </Link>
            }
          />
        ) : (
          <>
            <div className="chart-legend">
              <span>
                <i className="legend-line" />
                平均记忆预测
              </span>
              {data.coverage.eligible > 1 && (
                <span>
                  <i className="legend-band" />
                  不同单词的记忆差异（中间50%）
                </span>
              )}
              <span className="coverage-label">
                参与 {data.coverage.eligible} / {data.coverage.total} 词
              </span>
            </div>
            <MemoryChart data={data} horizon={horizon} />
            <p className="fine-print">
              截至 {formatDate(data.asOf)} · 记录还少时，预测仅供参考；复习后会随你的表现更新。
            </p>
          </>
        )}
      </Panel>
      <div className="memory-details">
        <Panel>
          <div className="panel-title">
            <RotateCcw size={19} />
            <h2>真实回忆反馈</h2>
          </div>
          <p>按复习间隔统计自评结果，与客观拼写正确率分开。</p>
          {data?.recallBins.some((bin) => bin.count > 0) ? (
            <div className="recall-bins">
              {data.recallBins.map((bin) => (
                <div key={bin.label}>
                  <span>{bin.label}</span>
                  <div>
                    <i style={{ width: `${clamp(bin.againRate ?? 0) * 100}%` }} />
                  </div>
                  <strong>
                    {bin.count ? `${Math.round((bin.againRate ?? 0) * 100)}% 忘记` : '无样本'}
                  </strong>
                  <small>{bin.count} 次反馈</small>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">复习记录还少，继续学习后再来看。</p>
          )}
          {data?.observations.length ? (
            <div className="observation-list">
              {data.observations
                .slice(-8)
                .reverse()
                .map((value, index) => (
                  <div key={`${value.reviewedAt}-${index}`}>
                    <span>{formatDate(value.reviewedAt)}</span>
                    <strong className={value.remembered ? 'sage-text' : 'rose-text'}>
                      {value.remembered ? '自评记得' : '自评忘记'}
                    </strong>
                    <small>
                      {value.expectedRetrievability === null
                        ? '初学 · 无间隔预测'
                        : `评价前预计 ${Math.round(value.expectedRetrievability * 100)}%`}
                    </small>
                  </div>
                ))}
            </div>
          ) : null}
        </Panel>
        <Panel>
          <div className="panel-title">
            <Clock3 size={19} />
            <h2>学习足迹</h2>
          </div>
          <p>看看最近两周的新学和复习。</p>
          {stats.data?.trends.some((day) => day.newWords || day.reviews) ? (
            <div className="activity-bars" aria-label="真实学习活动趋势">
              {stats.data.trends.slice(-14).map((day) => {
                const max = Math.max(
                  1,
                  ...stats.data!.trends.map((value) => value.newWords + value.reviews),
                );
                return (
                  <span
                    key={day.date}
                    title={`${day.date} · 新学${day.newWords}，复习${day.reviews}`}
                  >
                    <i
                      style={{
                        height: `${Math.max(2, ((day.newWords + day.reviews) / max) * 100)}%`,
                      }}
                    />
                    <small>{day.date.slice(-2)}</small>
                  </span>
                );
              })}
            </div>
          ) : (
            <Empty
              title="还没有足够的活动记录。"
              description="完成学习后，真实趋势会出现在这里。"
            />
          )}
          <div className="profile-links">
            <Link to="/review">
              打开到期复习 <ArrowRight size={15} />
            </Link>
            <Link to="/assessment">
              测一测词汇水平 <ArrowRight size={15} />
            </Link>
          </div>
        </Panel>
      </div>
    </div>
  );
}
