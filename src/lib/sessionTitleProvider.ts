import { invoke } from '@tauri-apps/api/core';
import { hasTauriRuntime } from './runtime';
import {
  SESSION_TITLE_OLLAMA_MODEL,
  buildTitlePrompt,
  isPlausibleProviderTitle,
  normalizeProviderTitle,
} from './sessionTitle';

/** Ask the local OpenCode title model (via Tauri → Ollama chat, keep_alive 0). */
export async function generateProviderSessionTitle(userText: string): Promise<string | null> {
  const prompt = buildTitlePrompt(userText);
  if (!prompt.trim()) return null;
  if (!hasTauriRuntime()) return null;
  try {
    const raw = await invoke<string>('generate_session_title', {
      prompt,
      model: SESSION_TITLE_OLLAMA_MODEL,
    });
    const title = normalizeProviderTitle(raw ?? '');
    if (!title || !isPlausibleProviderTitle(userText, title)) return null;
    return title;
  } catch {
    return null;
  }
}
