import { describe, expect, it } from 'vitest';
import {
  attachmentToAcpBlock,
  mergeHydratedAttachments,
  toPersistedAttachmentRef,
  type ComposerAttachment,
} from '../attachments';

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
  it('creates a durable reference without copying the data URL into history', () => {
    expect(toPersistedAttachmentRef(attachment())).toEqual({
      id: 'a1',
      name: 'sample.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      assetId: 'a1',
    });
  });

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

describe('mergeHydratedAttachments', () => {
  it('keeps every attachment loaded for the same messageId', () => {
    const video = attachment({
      id: 'v1',
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      dataUrl: 'data:video/mp4;base64,dmlk',
    });
    const image = attachment({ id: 'i1', name: 'shot.png', dataUrl: 'data:image/png;base64,aW1n' });

    expect(
      mergeHydratedAttachments({}, [
        { messageId: 'm1', attachment: video },
        { messageId: 'm1', attachment: image },
      ]),
    ).toEqual({ m1: [video, image] });
  });

  it('does not clobber in-memory data URLs for a just-sent message', () => {
    const memory = attachment({
      id: 'v1',
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      dataUrl: 'data:video/mp4;base64,bWVt',
    });
    const disk = attachment({
      id: 'v1',
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      dataUrl: 'data:video/mp4;base64,ZGlzaw==',
    });

    const result = mergeHydratedAttachments({ m1: [memory] }, [
      { messageId: 'm1', attachment: disk },
    ]);
    expect(result.m1).toHaveLength(1);
    expect(result.m1[0].dataUrl).toBe(memory.dataUrl);
  });

  it('fills a missing sibling from disk without dropping in-memory attachments', () => {
    const video = attachment({
      id: 'v1',
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      dataUrl: 'data:video/mp4;base64,bWVt',
    });
    const image = attachment({
      id: 'i1',
      name: 'shot.png',
      dataUrl: 'data:image/png;base64,ZGlzaw==',
    });

    const result = mergeHydratedAttachments({ m1: [video] }, [
      { messageId: 'm1', attachment: { ...video, dataUrl: 'data:video/mp4;base64,ZGlzaw==' } },
      { messageId: 'm1', attachment: image },
      null,
    ]);
    expect(result.m1.map((item) => item.id)).toEqual(['v1', 'i1']);
    expect(result.m1[0].dataUrl).toBe(video.dataUrl);
    expect(result.m1[1].dataUrl).toBe(image.dataUrl);
  });
});
