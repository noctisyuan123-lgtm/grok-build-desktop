/** DeepSeek-harness-style first-prompt session titles.
 *
 * Cadence mirrors `@deepseek-ai/dsh-session-title` + `session-title-first-prompt-llm`:
 * immediate deterministic fallback, one async provider revision for a fresh
 * non-fork session, user rename pins forever (until an explicit refresh later).
 * Failures keep the fallback; later user prompts never retitle (no all-prompts).
 */

import { deriveConversationTitle } from './conversationTitle';

export type SessionTitleSource = 'fallback' | 'provider' | 'user';

export const SESSION_TITLE_OLLAMA_MODEL = 'supra-title-350m-q4';

export function fallbackSessionTitle(firstPrompt: string): string {
  return deriveConversationTitle(firstPrompt);
}

/** Display priority: user pin > provider > live fallback from first prompt. */
export function resolveSessionTitle(input: {
  firstPrompt: string;
  userLabel?: string | null;
  providerTitle?: string | null;
}): { title: string; source: SessionTitleSource } {
  const user = input.userLabel?.trim();
  if (user) return { title: user, source: 'user' };
  const provider = input.providerTitle?.trim();
  if (provider) return { title: provider, source: 'provider' };
  return { title: fallbackSessionTitle(input.firstPrompt), source: 'fallback' };
}

/** First-prompt provider may run only once on a fresh non-fork session. */
export function shouldScheduleFirstPromptProvider(input: {
  isFork: boolean;
  alreadyAttempted: boolean;
  source?: SessionTitleSource | null;
}): boolean {
  if (input.isFork) return false;
  if (input.alreadyAttempted) return false;
  if (input.source === 'user') return false;
  return true;
}

/** Provider may overwrite fallback/provider, never a user pin (CAS). */
export function canAcceptProviderTitle(source?: SessionTitleSource | null): boolean {
  return source !== 'user';
}

export function buildTitlePrompt(userText: string): string {
  const cleaned = userText.replace(/\s+/g, ' ').trim();
  // Completion priming keeps Supra-Title-350M in title mode (plain text chats).
  return `User: ${cleaned}\nTitle: `;
}


/** Drop provider titles that are unrelated gibberish (tiny local models). */
export function isPlausibleProviderTitle(firstPrompt: string, title: string): boolean {
  const t = title.trim();
  if (t.length < 2 || t.length > 80) return false;
  // Reject chatty completions that escaped title mode.
  if (/[.!?。！？]|\n/.test(t) || t.length > 64) return false;
  const prompt = firstPrompt.replace(/\s+/g, ' ').trim();
  if (!prompt) return false;
  const promptHasCjk = /[\u3400-\u9fff]/.test(prompt);
  const titleHasCjk = /[\u3400-\u9fff]/.test(t);
  const promptLower = prompt.toLowerCase();
  const titleTokens = t
    .toLowerCase()
    .split(/[^a-z0-9\u3400-\u9fff]+/i)
    .filter((w) => w.length >= 2);
  if (titleTokens.length === 0) return false;

  const promptLatin = promptLower.match(/[a-z][a-z0-9]{1,}/g) ?? [];
  const promptLatinSet = new Set(promptLatin);
  const latinOverlap = titleTokens.some((tok) => {
    if (!/^[a-z0-9]+$/.test(tok) || tok.length < 3) return false;
    if (promptLatinSet.has(tok)) return true;
    if (tok.endsWith('s') && promptLatinSet.has(tok.slice(0, -1))) return true;
    if (promptLatinSet.has(`${tok}s`)) return true;
    return false;
  });

  if (promptHasCjk && titleHasCjk) return true;
  if (promptHasCjk && !titleHasCjk) return latinOverlap;
  if (titleTokens.some((tok) => promptLower.includes(tok) && tok.length >= 3)) return true;
  if (latinOverlap) return true;
  if (promptLower.includes(t.toLowerCase())) return true;
  return false;
}

export function normalizeProviderTitle(raw: string): string {
  return raw
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/^(?:title\s*[:：]\s*)/i, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}
