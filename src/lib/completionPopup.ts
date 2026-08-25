import { invoke } from '@tauri-apps/api/core';
import { hasTauriRuntime } from './runtime';

/**
 * Show the app-owned completion window. Unlike Notification Center banners,
 * this remains visible when Grok Desktop itself is frontmost.
 */
export async function showCompletionPopup(): Promise<void> {
  if (!hasTauriRuntime()) return;

  try {
    await invoke('show_completion_popup');
  } catch {
    // Completion feedback is optional; a popup failure must never affect the
    // finished run or its transcript.
  }
}
