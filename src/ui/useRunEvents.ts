import { useEffect, useRef, useState } from 'react';
import type { Run } from '../shared';
import { createReloadCoalescer } from './reload-coalescer';

const empty = { items: [], error: '' };

export function useRunEvents(run?: Run) {
  const runId = run?.binding.run_id;
  const status = run?.status;
  const [state, setState] = useState<{ runId: string; items: any[]; error: string }>();
  const schedule = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!runId) return;
    let current = true;
    const refresh = createReloadCoalescer(async () => {
      const items = await window.arc.invoke<any[]>('run_events', { run_id: runId });
      if (current) setState({ runId, items, error: '' });
    }, 250, reason => {
      if (current) setState(previous => ({
        runId,
        items: previous?.runId === runId ? previous.items : [],
        error: (reason as Error).message,
      }));
    });
    schedule.current = refresh.schedule;
    const off = window.arc.onEvent(e => {
      if (e.type === 'run_event' && e.run_id === runId) refresh.schedule();
    });
    return () => {
      current = false;
      schedule.current = null;
      refresh.cancelScheduled();
      off();
    };
  }, [runId]);

  useEffect(() => {
    schedule.current?.();
  }, [runId, status]);

  return state && state.runId === runId ? state : empty;
}
