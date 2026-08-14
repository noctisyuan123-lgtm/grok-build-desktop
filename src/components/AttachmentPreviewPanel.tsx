import { Download, FileText, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ComposerAttachment } from '../lib/attachments';
import { t } from '../i18n';

interface Props {
  attachment: ComposerAttachment | null;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isTextAttachment(attachment: ComposerAttachment): boolean {
  if (attachment.mimeType.startsWith('text/')) return true;
  return /\.(c|cc|cpp|css|csv|html?|js|json|md|py|rs|sh|sql|toml|ts|tsx|txt|yaml|yml)$/i.test(
    attachment.name,
  );
}

function decodeDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return '';
  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  if (!header.includes(';base64')) return decodeURIComponent(payload);

  const binary = window.atob(payload);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function attachmentKind(attachment: ComposerAttachment): string {
  if (attachment.mimeType) return attachment.mimeType;
  const extension = attachment.name.split('.').pop();
  return extension ? extension.toUpperCase() : 'FILE';
}

export function AttachmentPreviewPanel({ attachment, onClose }: Props) {
  const [textContent, setTextContent] = useState('');

  const textAttachment = attachment ? isTextAttachment(attachment) : false;
  useEffect(() => {
    if (!attachment || !textAttachment) {
      setTextContent('');
      return;
    }
    try {
      setTextContent(decodeDataUrl(attachment.dataUrl));
    } catch {
      setTextContent('');
    }
  }, [attachment, textAttachment]);

  const metadata = useMemo(() => {
    if (!attachment) return '';
    return `${attachmentKind(attachment)} · ${formatBytes(attachment.sizeBytes)}`;
  }, [attachment]);

  const open = Boolean(attachment);
  const isImage = attachment?.mimeType.startsWith('image/') ?? false;
  const isPdf = attachment?.mimeType === 'application/pdf';

  return (
    <aside
      aria-hidden={!open}
      aria-label={t('attachmentPreview.title')}
      className={`attachment-preview-panel${open ? ' open' : ''}${isImage ? ' is-image' : ''}`}
      role="dialog"
    >
      {attachment ? (
        <>
          <header className="attachment-preview-head">
            <div>
              <FileText aria-hidden="true" size={16} />
              <strong title={attachment.name}>{attachment.name}</strong>
            </div>
            <div className="attachment-preview-actions">
              <a
                aria-label={t('attachmentPreview.download', { name: attachment.name })}
                className="icon-button"
                download={attachment.name}
                href={attachment.dataUrl}
                title={t('attachmentPreview.download', { name: attachment.name })}
              >
                <Download aria-hidden="true" size={16} />
              </a>
              <button
                aria-label={t('attachmentPreview.close')}
                className="icon-button"
                title={t('attachmentPreview.close')}
                type="button"
                onClick={onClose}
              >
                <X aria-hidden="true" size={17} />
              </button>
            </div>
          </header>
          <div className="attachment-preview-body">
            {isImage ? (
              <img
                alt={t('attachmentPreview.imageAlt', { name: attachment.name })}
                className="attachment-preview-image"
                src={attachment.dataUrl}
              />
            ) : isPdf ? (
              <iframe
                className="attachment-preview-document"
                src={attachment.dataUrl}
                title={attachment.name}
              />
            ) : textAttachment ? (
              <pre className="attachment-preview-text">{textContent}</pre>
            ) : (
              <div className="attachment-preview-file">
                <FileText aria-hidden="true" size={36} />
                <strong>{attachment.name}</strong>
                <span>{metadata}</span>
                <a download={attachment.name} href={attachment.dataUrl}>
                  <Download aria-hidden="true" size={14} />
                  {t('attachmentPreview.download', { name: attachment.name })}
                </a>
                <small>{t('attachmentPreview.noInlinePreview')}</small>
              </div>
            )}
          </div>
          <footer className="attachment-preview-meta">{metadata}</footer>
        </>
      ) : null}
    </aside>
  );
}
