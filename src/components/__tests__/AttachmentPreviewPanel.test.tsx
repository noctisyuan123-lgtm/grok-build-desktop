import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentPreviewPanel } from '../AttachmentPreviewPanel';

describe('AttachmentPreviewPanel', () => {
  it('renders text files inline and can be closed', async () => {
    const onClose = vi.fn();
    const attachment = {
      id: 'text-1',
      name: 'notes.txt',
      mimeType: 'text/plain',
      sizeBytes: 11,
      dataUrl: 'data:text/plain;base64,aGVsbG8gd29ybGQ=',
    };

    render(<AttachmentPreviewPanel attachment={attachment} onClose={onClose} />);

    await waitFor(() => expect(screen.getByText('hello world')).toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Attachment preview' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close attachment preview' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders an image with a download action', () => {
    const attachment = {
      id: 'image-1',
      name: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: 128,
      dataUrl: 'data:image/png;base64,AAAA',
    };

    render(<AttachmentPreviewPanel attachment={attachment} onClose={() => undefined} />);

    expect(screen.getByRole('img', { name: 'Preview of photo.png' })).toHaveAttribute(
      'src',
      attachment.dataUrl,
    );
    expect(screen.getByRole('link', { name: 'Download photo.png' })).toHaveAttribute(
      'download',
      'photo.png',
    );
  });
});
