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

/**
 * True when `localTab` is a reinstall bootstrap ghost of something already on
 * disk: an empty placeholder (typical after localStorage wipe → `makeTab()`),
 * or a transcript whose message ids are a subset of a disk tab
 * (`session_state.json` restored into a freshly minted tab id).
 *
 * Forks keep distinct tab ids that are both persisted on disk, so they are
 * never "local-only" and are not collapsed by this check.
 */
export function isReinstallGhostTab(localTab: Tab, diskTabs: Tab[]): boolean {
  if (diskTabs.length === 0) return false;
  const messages = localTab.messages ?? [];
  // Boot `makeTab()` synthesizes an empty tab with no sessionHead. When disk
  // already has sessions, that local-only empty is the reinstall ghost — drop
  // it even if disk has no empty twin (the common HISTORY duplicate case).
  if (messages.length === 0 && !localTab.sessionHead) {
    return true;
  }
  // Empty but somehow bound: only treat as ghost when an empty twin exists.
  if (messages.length === 0) {
    return diskTabs.some(
      (disk) => (disk.messages?.length ?? 0) === 0 && (disk.cwd ?? '') === (localTab.cwd ?? ''),
    );
  }
  const localIds = messages.map((message) => message.id);
  return diskTabs.some((disk) => {
    const diskIds = new Set((disk.messages ?? []).map((message) => message.id));
    return localIds.length > 0 && localIds.every((id) => diskIds.has(id));
  });
}

/**
 * Union tabs by id, keeping the copy with more messages. Local order wins for
 * shared ids. Local-only tabs that are content ghosts of disk (typical after
 * a reinstall clears WebView localStorage while Application Support keeps
 * conversations.json) are dropped so HISTORY does not show duplicates.
 *
 * Also collapses multiple empty untitled local+disk twins so only one empty
 * slate survives the merge.
 */
export function mergeTabLists(local: Tab[], disk: Tab[]): Tab[] {
  if (disk.length === 0) return local;
  if (local.length === 0) return disk;
  const diskIds = new Set(disk.map((tab) => tab.id));
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
    if (!chosen) continue;
    // Fresh tab id from a cleared cache: drop if disk already holds the same
    // conversation (or an empty bootstrap). Persisted forks share disk ids and
    // skip this branch.
    if (!diskIds.has(tab.id) && isReinstallGhostTab(chosen, disk)) continue;
    merged.push(chosen);
    seen.add(tab.id);
  }
  for (const tab of disk) {
    if (seen.has(tab.id)) continue;
    const chosen = best.get(tab.id);
    if (chosen) merged.push(chosen);
  }
  return dedupeEmptyUntitledTabs(merged);
}

/** Keep a single empty untitled session when several empty twins survived. */
function dedupeEmptyUntitledTabs(tabs: Tab[]): Tab[] {
  let keptEmpty = false;
  const out: Tab[] = [];
  for (const tab of tabs) {
    const empty = (tab.messages?.length ?? 0) === 0 && !tab.sessionHead;
    if (!empty) {
      out.push(tab);
      continue;
    }
    if (keptEmpty) continue;
    keptEmpty = true;
    out.push(tab);
  }
  return out;
}

export function tabMessages(tab: Tab | undefined): ChatMessage[] {
  return (tab?.messages ?? []) as ChatMessage[];
}
