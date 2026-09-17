import { invoke } from '@tauri-apps/api/core';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 8;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 25 * 1024 * 1024;

export interface ComposerAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

/** Durable message metadata. The bytes live in the session's assets folder. */
export interface PersistedAttachmentRef {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  assetId: string;
}

export type AcpAttachmentBlock =
  | { type: 'image'; data: string; mimeType: string }
  | {
      type: 'resource';
      resource: { uri: string; mimeType: string; blob: string };
    };

interface NativeAttachment {
  name: string;
  mime_type: string;
  size_bytes: number;
  data_url: string;
}

function attachmentId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  // Keep the durable asset filename path-safe. The display name is stored
  // separately, so it does not need to be part of the identity.
  return random;
}

export function toPersistedAttachmentRef(attachment: ComposerAttachment): PersistedAttachmentRef {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    assetId: attachment.id,
  };
}

export function fileToAttachment(file: File): Promise<ComposerAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(`Could not read ${file.name}`));
        return;
      }
      resolve({
        id: attachmentId(),
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        dataUrl: reader.result,
      });
    };
    reader.readAsDataURL(file);
  });
}

export async function readNativeAttachment(path: string): Promise<ComposerAttachment> {
  const raw = await invoke<NativeAttachment>('read_attachment', {
    path,
    maxBytes: MAX_ATTACHMENT_BYTES,
  });
  return {
    id: attachmentId(),
    name: raw.name,
    mimeType: raw.mime_type,
    sizeBytes: raw.size_bytes,
    dataUrl: raw.data_url,
  };
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const VIDEO_EXT = /\.(3gp|avi|m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm|wmv)$/i;

export function isVideoAttachment(attachment: { mimeType: string; name: string }): boolean {
  if (attachment.mimeType.startsWith('video/')) return true;
  if (attachment.mimeType && attachment.mimeType !== 'application/octet-stream') return false;
  return VIDEO_EXT.test(attachment.name);
}

/** Disk rehydrate for one session. Keep in-memory just-sent bytes; add missing siblings. */
export function mergeHydratedAttachments(
  current: Record<string, ComposerAttachment[]>,
  loaded: Array<{ messageId: string; attachment: ComposerAttachment } | null>,
): Record<string, ComposerAttachment[]> {
  const grouped: Record<string, ComposerAttachment[]> = {};
  for (const item of loaded) {
    if (!item) continue;
    const bucket = grouped[item.messageId];
    if (bucket) bucket.push(item.attachment);
    else grouped[item.messageId] = [item.attachment];
  }

  const next = { ...current };
  for (const messageId of Object.keys(grouped)) {
    const incoming = grouped[messageId];
    const existing = next[messageId];
    if (!existing) {
      next[messageId] = incoming;
      continue;
    }

    const byId = new Map(existing.map((attachment) => [attachment.id, attachment]));
    for (const attachment of incoming) {
      const prev = byId.get(attachment.id);
      if (!prev) {
        byId.set(attachment.id, attachment);
      } else if (!prev.dataUrl && attachment.dataUrl) {
        byId.set(attachment.id, { ...prev, dataUrl: attachment.dataUrl });
      }
    }

    const merged: ComposerAttachment[] = [];
    const seen = new Set<string>();
    for (const attachment of existing) {
      merged.push(byId.get(attachment.id) ?? attachment);
      seen.add(attachment.id);
    }
    for (const attachment of incoming) {
      if (seen.has(attachment.id)) continue;
      merged.push(attachment);
      seen.add(attachment.id);
    }
    next[messageId] = merged;
  }
  return next;
}

/** Convert our preview-friendly data URL into the ACP content block schema
 * accepted by Grok CLI's --prompt-json flag. ACP wants raw base64 in `data`
 * / `blob`; it does not accept Responses API `input_image` blocks. */
export function attachmentToAcpBlock(attachment: ComposerAttachment): AcpAttachmentBlock {
  const marker = ';base64,';
  const markerIndex = attachment.dataUrl.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Attachment ${attachment.name} is not base64 encoded.`);
  const base64 = attachment.dataUrl.slice(markerIndex + marker.length);
  if (!base64) throw new Error(`Attachment ${attachment.name} is empty.`);
  if (attachment.mimeType.startsWith('image/')) {
    return {
      type: 'image',
      data: base64,
      mimeType: attachment.mimeType,
    };
  }
  return {
    type: 'resource',
    resource: {
      uri: `attachment:///${encodeURIComponent(attachment.name)}`,
      mimeType: attachment.mimeType,
      blob: base64,
    },
  };
}
