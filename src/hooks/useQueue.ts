import { useSyncExternalStore } from 'react';
import { streamStore } from '../lib/streamStore';

const emptyQueue = {
  active: null as string | null,
  activeIds: [] as string[],
  items: [] as Array<{
    id: string;
    prompt: string;
    cwd?: string;
    state: 'Queued' | 'Running' | 'Done' | 'Cancelled' | 'Failed';
    enqueuedAt: number;
    laneId?: string;
  }>,
};

export function useQueue() {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => streamStore.getQueueSnapshot(),
    () => emptyQueue,
  );
}
