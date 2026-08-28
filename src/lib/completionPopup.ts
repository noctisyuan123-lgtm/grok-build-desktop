import { invoke } from '@tauri-apps/api/core';
import { hasTauriRuntime } from './runtime';

/**
 * Show the app-owned completion window. Unlike Notification Center banners,
 * this remains visible when Grok Desktop itself is frontmost.
 */
export async function showCompletionPopup(tabId: string): Promise<void> {
  if (!hasTauriRuntime()) return;

  try {
    await invoke('show_completion_popup', { tabId });
  } catch {
    // Completion feedback is optional; a popup failure must never affect the
    // finished run or its transcript.
  }
}

/** Normalize the banner event payload so a missed listen still clicks through. */
export function tabIdFromPayload(payload: unknown): string | null {
  if (typeof payload === 'string' && payload.length > 0) return payload;
  if (payload && typeof payload === 'object' && 'tabId' in payload) {
    const tabId = (payload as { tabId?: unknown }).tabId;
    return typeof tabId === 'string' && tabId.length > 0 ? tabId : null;
  }
  return null;
}
