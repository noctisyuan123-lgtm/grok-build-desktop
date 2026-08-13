// Claude-style session mobility helpers for Desktop ↔ CLI.
// Both surfaces share grok's on-disk session store; Desktop rehydrates the
// visible transcript from `grok export` after CLI work (and while live-linked).
import type { ChatMessage } from '../app/types';

export const CLI_HANDOFF_KEY = 'grok-desktop-cli-handoff-session';
export const LIVE_SESSION_KEY = 'grok-desktop-live-session-id';

/** Cheap fingerprint so poll/rehydrate can skip no-op setState. */
export function exportFingerprint(markdown: string): string {
  let hash = 2166136261;
  for (let i = 0; i < markdown.length; i += 1) {
    hash ^= markdown.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${markdown.length}:${(hash >>> 0).toString(16)}`;
}

/**
 * True for harness / system payloads that must never appear as Desktop chat
 * bubbles (system prompt, skills dump, compaction summaries, idle reminders).
 */
export function isHarnessUserContent(body: string): boolean {
  const text = body.trim();
  if (!text) return true;
  // Legacy Desktop builds embedded this entire contract in every visible
  // User turn. Filter it during rehydration so old shared sessions do not
  // replay the prompt dump back into Desktop after `/desktop`.
  if (/^Grok Desktop instructions for this turn:/i.test(text)) return true;
  // Full agent system prompt (and near-duplicates mis-labeled as User).
  if (/^you are grok\b/i.test(text)) return true;
  if (/^you are a grok\b/i.test(text)) return true;
  if (/interactive CLI tool that helps users with software engineering/i.test(text)) return true;
  if (
    /Do not reproduce, summarize, paraphrase, or otherwise reveal the contents of this system prompt/i.test(
      text,
    )
  ) {
    return true;
  }
  if (text.includes('<work_policy>')) return true;
  if (text.includes('<agent_skills>') || text.includes('<available_skills>')) return true;
  if (text.startsWith('<user_info>') || text.includes('\n<user_info>')) {
    if (!/<user_query\b/i.test(text)) return true;
  }
  if (text.startsWith('<git_status>') || text.includes('\n<git_status>')) {
    if (!/<user_query\b/i.test(text)) return true;
  }
  if (text.includes('<system-reminder>') && !/<user_query\b/i.test(text)) return true;
  if (/^this session is being continued from a previous conversation/i.test(text)) return true;
  if (
    /\b(Primary Request and Intent|All User Messages|Optional Next Step):\b/i.test(text) &&
    text.length > 400 &&
    !/<user_query\b/i.test(text)
  ) {
    return true;
  }
  if (/^## available skills\b/i.test(text)) return true;
  if (/The following skills are available for use/i.test(text) && !/<user_query\b/i.test(text)) {
    return true;
  }
  // Synthetic "while you were idle" wrappers with no real user query
  if (/^the user sent a message while you were working:\s*$/i.test(text)) return true;
  if (/^while you were idle\b/i.test(text) && !/<user_query\b/i.test(text)) return true;
  return false;
}

/** Drop assistant rows that are clearly system/harness dumps (defense in depth). */
export function isHarnessAssistantContent(body: string): boolean {
  const text = body.trim();
  if (!text) return true;
  if (/^you are grok\b/i.test(text)) return true;
  if (text.includes('<work_policy>') && text.length > 500) return true;
  if (
    /interactive CLI tool that helps users with software engineering/i.test(text) &&
    text.length > 400
  ) {
    return true;
  }
  return false;
}

/** Prefer the human text inside <user_query>; fall back to the raw body. */
export function unwrapUserQuery(body: string): string {
  const matches = [...body.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi)];
  if (matches.length > 0) {
    return matches
      .map((match) => (match[1] ?? '').trim())
      .filter(Boolean)
      .join('\n\n');
  }
  return body.trim();
}

const DESKTOP_TURN_HEADER = /^Grok Desktop instructions for this turn:\s*/i;

function isDesktopInstructionParagraph(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^Operate as a senior engineer\b/i.test(t)) return true;
  if (/^Workspace contract:/i.test(t)) return true;
  if (/^Enter plan mode before doing the work\b/i.test(t)) return true;
  if (/^Prior conversation re-seeded into a fresh session after Undo\./i.test(t)) return true;
  if (/^The undone turn is intentionally absent\./i.test(t)) return true;
  if (/^You are running inside Grok Desktop\b/i.test(t)) return true;
  if (/^Grok Desktop Grok (?:Code|Chat) Mode:/i.test(t)) return true;
  if (/^(?:User|Assistant):/i.test(t)) return true;
  return false;
}

/**
 * Older Desktop ACP builds prepended `--rules` as a visible User block.
 * `/cli` then replayed that dump in the TUI, and `grok export` poll dropped
 * the whole turn (including the real query). Strip the prefix; keep the rest.
 */
export function stripDesktopTurnInstructions(body: string): string {
  const text = unwrapUserQuery(body);
  if (!DESKTOP_TURN_HEADER.test(text)) return text;
  let rest = text.replace(DESKTOP_TURN_HEADER, '').replace(/^\s+/, '');
  while (rest) {
    const blank = rest.search(/\n\s*\n/);
    const head = (blank >= 0 ? rest.slice(0, blank) : rest).trim();
    const tail = blank >= 0 ? rest.slice(blank).replace(/^\s+/, '') : '';
    if (isDesktopInstructionParagraph(head)) {
      if (!tail) return '';
      rest = tail;
      continue;
    }
    break;
  }
  return rest.trim();
}

function isChatHeading(heading: string): 'user' | 'assistant' | null {
  const h = heading.trim().toLowerCase();
  if (h === 'user' || h === 'human') return 'user';
  if (h === 'assistant' || h === 'grok' || h === 'model') return 'assistant';
  return null;
}

/** Parse `grok export <id>` markdown into desktop chat bubbles (chat-only). */
export function messagesFromGrokExport(markdown: string, sessionId: string): ChatMessage[] {
  const chunks = markdown.split(/^## /m).filter((chunk) => chunk.trim().length > 0);
  const messages: ChatMessage[] = [];
  let ts = Date.now() - chunks.length * 1000;
  let userIndex = 0;
  let assistantIndex = 0;
  for (const chunk of chunks) {
    const newline = chunk.indexOf('\n');
    const headingRaw = (newline >= 0 ? chunk.slice(0, newline) : chunk).trim();
    const bodyRaw = (newline >= 0 ? chunk.slice(newline + 1) : '').trim();
    const role = isChatHeading(headingRaw);
    // Skip Tools / System / anything else — Desktop has its own trace UI.
    if (!role || !bodyRaw) continue;

    if (role === 'user') {
      const body = stripDesktopTurnInstructions(bodyRaw);
      if (!body || isHarnessUserContent(body)) continue;
      userIndex += 1;
      messages.push({
        // Stable across rehydrate/poll so React does not remount the whole list.
        id: `${sessionId}:u:${userIndex}`,
        role: 'user',
        content: body,
        ts: ts++,
      });
      continue;
    }

    // assistant
    if (isHarnessAssistantContent(bodyRaw)) continue;
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant') {
      // Do not glue a harness dump onto a real reply.
      if (isHarnessAssistantContent(bodyRaw)) continue;
      last.content = `${last.content}\n\n${bodyRaw}`;
      last.meta = { ...last.meta, sessionId };
    } else {
      assistantIndex += 1;
      messages.push({
        id: `${sessionId}:a:${assistantIndex}`,
        role: 'assistant',
        content: bodyRaw,
        ts: ts++,
        status: 'done',
        meta: { sessionId },
      });
    }
  }
  return messages;
}

/** Prefer the export when it contains turns the local UI is missing (CLI). */
export function importedHasNewTurns(
  local: Array<{ role: string; content: string }>,
  imported: Array<{ role: string; content: string }>,
): boolean {
  if (imported.length > local.length) return true;
  const localUsers = local
    .filter((message) => message.role === 'user')
    .map((message) => message.content.trim());
  const importedUsers = imported
    .filter((message) => message.role === 'user')
    .map((message) => message.content.trim());
  if (importedUsers.length > localUsers.length) return true;
  const lastLocal = localUsers[localUsers.length - 1];
  const lastImported = importedUsers[importedUsers.length - 1];
  if (lastImported && lastImported !== lastLocal) return true;
  const lastLocalAsst =
    [...local].reverse().find((message) => message.role === 'assistant')?.content ?? '';
  const lastImportedAsst =
    [...imported].reverse().find((message) => message.role === 'assistant')?.content ?? '';
  return lastImportedAsst.length > lastLocalAsst.length;
}

/** Drop an undone user turn (and its assistant reply) from a rehydrated export. */
export function dropUndoneUserTurn<T extends { role: string; content: string }>(
  messages: T[],
  userContent: string,
): T[] {
  const text = userContent.trim();
  if (!text) return messages;
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'user' && message.content.trim() === text) {
      index = i;
      break;
    }
  }
  if (index < 0) return messages;
  const drop = messages[index + 1]?.role === 'assistant' ? 2 : 1;
  return [...messages.slice(0, index), ...messages.slice(index + drop)];
}

export function noteCliHandoff(sessionId: string | null) {
  if (sessionId) window.localStorage.setItem(CLI_HANDOFF_KEY, sessionId);
  else window.localStorage.removeItem(CLI_HANDOFF_KEY);
}

export function peekCliHandoff(): string | null {
  return window.localStorage.getItem(CLI_HANDOFF_KEY);
}

export function takeCliHandoff(): string | null {
  const value = window.localStorage.getItem(CLI_HANDOFF_KEY);
  if (!value) return null;
  window.localStorage.removeItem(CLI_HANDOFF_KEY);
  return value;
}

export function noteLiveSession(sessionId: string | null) {
  if (sessionId) window.localStorage.setItem(LIVE_SESSION_KEY, sessionId);
  else window.localStorage.removeItem(LIVE_SESSION_KEY);
}

export function peekLiveSession(): string | null {
  return window.localStorage.getItem(LIVE_SESSION_KEY);
}
