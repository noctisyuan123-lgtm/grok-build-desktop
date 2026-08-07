import { describe, expect, it } from 'vitest';
import { attachmentToAcpBlock, type ComposerAttachment } from '../attachments';

function attachment(overrides: Partial<ComposerAttachment> = {}): ComposerAttachment {
  return {
    id: 'a1',
    name: 'sample.png',
    mimeType: 'image/png',
    sizeBytes: 3,
    dataUrl: 'data:image/png;base64,YWJj',
    ...overrides,
  };
}

describe('attachmentToAcpBlock', () => {
  it('emits ACP image blocks with raw base64 rather than a data URL', () => {
    expect(attachmentToAcpBlock(attachment())).toEqual({
      type: 'image',
      data: 'YWJj',
      mimeType: 'image/png',
    });
  });

  it('emits non-image files as embedded ACP blob resources', () => {
    expect(
      attachmentToAcpBlock(
        attachment({
          name: 'notes one.txt',
          mimeType: 'text/plain',
          dataUrl: 'data:text/plain;base64,aGVsbG8=',
        }),
      ),
    ).toEqual({
      type: 'resource',
      resource: {
        uri: 'attachment:///notes%20one.txt',
        mimeType: 'text/plain',
        blob: 'aGVsbG8=',
      },
    });
  });
});
