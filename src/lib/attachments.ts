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

function attachmentId(name: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${name}-${random}`;
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
        id: attachmentId(file.name),
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
    id: attachmentId(raw.name),
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
