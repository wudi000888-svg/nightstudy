import { useState } from 'react';
import { Check } from 'lucide-react';
import type { H5HomeSummary } from '../lib/h5-home-types';

export function LearningCalendar({
  calendar,
  localDate,
  timeZone,
}: {
  calendar: H5HomeSummary['calendar'];
  localDate: string;
  timeZone: string;
}) {
  const [selected, setSelected] = useState('');
  const day =
    calendar.days.find((item) => item.localDate === selected) ??
    calendar.days.find((item) => item.localDate === localDate);
  const first = calendar.days[0]?.localDate;
  const offset = first ? (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7 : 0;
  return (
    <div className="h5-calendar">
      <div className="h5-calendar-summary">
        <strong>
          连续学习 <span>{calendar.streak}</span> 天
        </strong>
        <small>近30天</small>
      </div>
      <div className="h5-calendar-grid" aria-label="最近30天的学习日历">
        {['一', '二', '三', '四', '五', '六', '日'].map((label) => (
          <span className="h5-calendar-weekday" key={label}>
            {label}
          </span>
        ))}
        {Array.from({ length: offset }, (_, index) => (
          <span key={`blank-${index}`} />
        ))}
        {calendar.days.map((item) => (
          <button
            type="button"
            key={item.localDate}
            className={`${item.checkedIn ? 'is-checked' : ''} ${item.localDate === localDate ? 'is-today' : ''}`}
            aria-label={`${item.localDate}，${item.checkedIn ? `已签到，完成${item.completedGroups}组学习` : '未签到'}`}
            aria-pressed={day?.localDate === item.localDate}
            onClick={() => setSelected(item.localDate)}
          >
            <span>{Number(item.localDate.slice(-2))}</span>
            {item.checkedIn ? <Check size={12} aria-hidden="true" /> : <i />}
          </button>
        ))}
      </div>
      <p className="h5-calendar-selected" aria-live="polite">
        {day
          ? `${day.localDate} · ${day.checkedIn ? `完成 ${day.completedGroups} 组，已签到` : '还没有完成的学习组'}`
          : '选择日期查看记录'}
      </p>
      <p className="h5-caption">完成当天一组学习，自动签到。{timeZone} · 凌晨4点换日。</p>
    </div>
  );
}
