import type { ChatMessage } from '../app/types';
import type { Tab } from './tabs';

/** Same conversation (shared ids) → keep the longer transcript. Else keep `local`. */
export function richerMessageList<T extends { id: string }>(local: T[], disk: T[]): T[] {
  if (disk.length === 0) return local;
  if (local.length === 0) return disk;
  const localIds = new Set(local.map((row) => row.id));
  const overlap = disk.some((row) => localIds.has(row.id));
  if (!overlap) return local;
  return disk.length > local.length ? disk : local;
}

/** Union tabs by id, keeping the copy with more messages. Local order wins. */
export function mergeTabLists(local: Tab[], disk: Tab[]): Tab[] {
  if (disk.length === 0) return local;
  if (local.length === 0) return disk;
  const best = new Map<string, Tab>();
  for (const tab of [...disk, ...local]) {
    const previous = best.get(tab.id);
    const nextCount = tab.messages?.length ?? 0;
    const previousCount = previous?.messages?.length ?? 0;
    if (!previous || nextCount >= previousCount) best.set(tab.id, tab);
  }
  const seen = new Set<string>();
  const merged: Tab[] = [];
  for (const tab of local) {
    const chosen = best.get(tab.id);
    if (chosen) merged.push(chosen);
    seen.add(tab.id);
  }
  for (const tab of disk) {
    if (seen.has(tab.id)) continue;
    const chosen = best.get(tab.id);
    if (chosen) merged.push(chosen);
  }
  return merged;
}

export function tabMessages(tab: Tab | undefined): ChatMessage[] {
  return (tab?.messages ?? []) as ChatMessage[];
}
