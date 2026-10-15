import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApp, useRemote } from '../../AppContext';
import { post } from '../../lib/api';
import type { Book } from '../../lib/types';
import { PlanConfirm } from './PlanConfirm';
import type { TaskPlanResponse } from './types';
import { useScreenActive } from '../../lib/screen-lifecycle';

export function useBookPlan() {
  const { user, scope } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const active = useScreenActive();
  const navigation = useRef({ key: location.key, active, generation: 0 });
  if (navigation.current.key !== location.key || navigation.current.active !== active) {
    navigation.current = {
      key: location.key,
      active,
      generation: navigation.current.generation + 1,
    };
  }
  const client = useQueryClient();
  const query = useRemote<TaskPlanResponse>('plan', 'study/plan', !!user);
  const [selected, setSelected] = useState<Book | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setSelected(null);
    return () => {
      generation.current++;
    };
  }, [scope]);
  function choose(book: Book) {
    if (!user) {
      navigate('/auth');
      return;
    }
    setSelected(book);
  }
  const settings = query.data?.settings;
  return {
    query,
    choose,
    dialog: (
      <PlanConfirm
        key={`${scope}:${selected?.id ?? 'none'}`}
        open={!!selected}
        book={selected}
        loading={query.isPending}
        error={query.error}
        onInitialRetry={() => {
          void query.refetch();
        }}
        initial={
          settings
            ? {
                dailyTotalGoal: settings.dailyTotalGoal,
                groupSize: settings.groupSize,
                timeZone: settings.pendingTimeZone ?? settings.timeZone,
              }
            : null
        }
        issuedCount={query.data?.plan.assignedUnique}
        onClose={() => setSelected(null)}
        onConfirm={async (values, revision, commandId) => {
          if (!selected) return;
          const request = generation.current;
          const navigationGeneration = navigation.current.generation;
          await post<TaskPlanResponse>('study/plan/confirm', {
            bookId: selected.id,
            ...values,
            expectedRevision: revision,
            commandId,
          });
          if (request !== generation.current) return;
          setSelected(null);
          await client.invalidateQueries({ queryKey: [scope] });
          if (
            request === generation.current &&
            navigation.current.active &&
            navigationGeneration === navigation.current.generation
          )
            navigate('/');
        }}
      />
    ),
  };
}
