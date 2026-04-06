import type { MessageItem, ImageItem } from './types.js';
import { MessageItemType } from './types.js';
import { downloadAndDecrypt } from './cdn.js';
import { logger } from '../logger.js';

function detectMimeType(data: Buffer): string {
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data[0] === 0xFF && data[1] === 0xD8) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49) return 'image/gif';
  if (data[0] === 0x52 && data[1] === 0x49) return 'image/webp';
  if (data[0] === 0x42 && data[1] === 0x4D) return 'image/bmp';
  return 'image/jpeg'; // fallback
}

/**
 * Extract AES key and encrypt_query_param from an ImageItem,
 * supporting both the old cdn_media format and the newer flat format.
 */
function getImageCdnData(imageItem: ImageItem): { aesKey: string; encryptQueryParam: string } | null {
  // Old format: cdn_media.aes_key + cdn_media.encrypt_query_param
  if (imageItem.cdn_media?.aes_key && imageItem.cdn_media?.encrypt_query_param) {
    return {
      aesKey: imageItem.cdn_media.aes_key,
      encryptQueryParam: imageItem.cdn_media.encrypt_query_param,
    };
  }

  // New format: aeskey + media.encrypt_query_param
  // Use media.aes_key (base64-of-hex) over aeskey (raw hex) since downloadAndDecrypt expects base64
  if (imageItem.media?.encrypt_query_param && (imageItem.media.aes_key || imageItem.aeskey)) {
    return {
      aesKey: imageItem.media.aes_key ?? imageItem.aeskey!,
      encryptQueryParam: imageItem.media.encrypt_query_param,
    };
  }

  logger.warn('Image item has no usable CDN data', {
    hasCdnMedia: !!imageItem.cdn_media,
    hasAeskey: !!imageItem.aeskey,
    hasMedia: !!imageItem.media,
  });
  return null;
}

/**
 * Download a CDN image, decrypt it, and return a base64 data URI.
 * Returns null on failure.
 */
export async function downloadImage(item: MessageItem): Promise<string | null> {
  const imageItem = item.image_item;
  if (!imageItem) {
    return null;
  }

  const cdnData = getImageCdnData(imageItem);
  if (!cdnData) {
    return null;
  }

  try {
    const decrypted = await downloadAndDecrypt(cdnData.encryptQueryParam, cdnData.aesKey);
    const mimeType = detectMimeType(decrypted);
    const base64 = decrypted.toString('base64');
    const dataUri = `data:${mimeType};base64,${base64}`;
    logger.info('Image downloaded and decrypted', { size: decrypted.length });
    return dataUri;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to download image', { error: msg });
    return null;
  }
}

/**
 * Extract text content from a message item.
 * Returns text_item.text or empty string.
 */
export function extractText(item: MessageItem): string {
  return item.text_item?.text ?? '';
}

/**
 * Extract referenced/quoted message context from items.
 * Returns a formatted prefix and optionally the referenced media item.
 */
export function extractRefMessage(items?: MessageItem[]): { prefix: string; mediaItem?: MessageItem } | null {
  if (!items) return null;

  for (const item of items) {
    const refMsg = item.text_item?.ref_msg;
    if (!refMsg) continue;

    const parts: string[] = [];
    if (refMsg.title) parts.push(refMsg.title);

    // Extract text from the referenced message item
    if (refMsg.message_item) {
      const refItem = refMsg.message_item;
      const refText = refItem.text_item?.text;
      if (refText) {
        parts.push(refText.length > 100 ? refText.slice(0, 100) + '...' : refText);
      } else if (refItem.type === MessageItemType.IMAGE) {
        parts.push('[图片]');
      } else if (refItem.type === MessageItemType.VOICE) {
        const voiceText = refItem.voice_item?.voice_text;
        parts.push(voiceText ? `[语音: ${voiceText}]` : '[语音]');
      } else if (refItem.type === MessageItemType.FILE) {
        parts.push(`[文件: ${refItem.file_item?.file_name ?? '未知'}]`);
      } else if (refItem.type === MessageItemType.VIDEO) {
        parts.push('[视频]');
      }

      // Check if the referenced item is media (image/video/file)
      const isMedia = refItem.type === MessageItemType.IMAGE ||
        refItem.type === MessageItemType.VIDEO ||
        refItem.type === MessageItemType.FILE;

      const prefix = `[引用: ${parts.join(' | ')}]`;
      return {
        prefix,
        mediaItem: isMedia ? refItem : undefined,
      };
    }

    if (parts.length > 0) {
      return { prefix: `[引用: ${parts.join(' | ')}]` };
    }
  }

  return null;
}

/**
 * Find the first IMAGE type item in a list.
 */
export function extractFirstImageUrl(items?: MessageItem[]): MessageItem | undefined {
  return items?.find((item) => item.type === MessageItemType.IMAGE);
}

/**
 * Find ALL IMAGE type items in a list.
 */
export function extractAllImageItems(items?: MessageItem[]): MessageItem[] {
  return items?.filter((item) => item.type === MessageItemType.IMAGE) ?? [];
}

/**
 * Extract voice-to-text content from a voice message item.
 * Returns the server-side STT result if available, or null.
 */
export function extractVoiceText(item: MessageItem): string | null {
  return item.voice_item?.voice_text ?? null;
}

/**
 * Find the first VOICE type item in a list.
 */
export function extractFirstVoiceItem(items?: MessageItem[]): MessageItem | undefined {
  return items?.find((item) => item.type === MessageItemType.VOICE);
}

/**
 * Find the first FILE type item in a list.
 */
export function extractFirstFileItem(items?: MessageItem[]): MessageItem | undefined {
  return items?.find((item) => item.type === MessageItemType.FILE);
}

/**
 * Download a CDN file, decrypt it, and return the buffer + metadata.
 * Works for FILE items that have cdn_media with aes_key and encrypt_query_param.
 * Returns null on failure.
 */
export async function downloadFile(item: MessageItem): Promise<{ data: Buffer; fileName: string; mimeType: string } | null> {
  const fileItem = item.file_item;
  if (!fileItem) return null;

  const cdnMedia = fileItem.cdn_media;
  if (!cdnMedia?.aes_key || !cdnMedia?.encrypt_query_param) {
    logger.warn('File item has no usable CDN data');
    return null;
  }

  try {
    const decrypted = await downloadAndDecrypt(cdnMedia.encrypt_query_param, cdnMedia.aes_key);
    const fileName = fileItem.file_name ?? 'file.bin';
    const mimeType = getMimeFromFileName(fileName);
    logger.info('File downloaded and decrypted', { fileName, size: decrypted.length });
    return { data: decrypted, fileName, mimeType };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to download file', { error: msg });
    return null;
  }
}

/**
 * Infer MIME type from file name extension.
 */
function getMimeFromFileName(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    html: 'text/html',
    md: 'text/markdown',
    py: 'text/x-python',
    js: 'text/javascript',
    ts: 'text/typescript',
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
  };
  return map[ext] ?? 'application/octet-stream';
}
