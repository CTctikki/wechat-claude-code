import { WeChatApi } from './api.js';
import { MessageItemType, MessageType, MessageState, UploadMediaType, type MessageItem, type OutboundMessage } from './types.js';
import { encryptAndUpload } from './cdn.js';
import { aesEcbPaddedSize } from './crypto.js';
import { logger } from '../logger.js';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { basename, resolve, extname } from 'node:path';

// ---------------------------------------------------------------------------
// Markdown → PlainText conversion
// ---------------------------------------------------------------------------

/**
 * Strip markdown formatting for WeChat display.
 * WeChat does not render markdown, so we convert to readable plain text.
 */
export function markdownToPlainText(text: string): string {
  let result = text;
  // 1. Fenced code blocks: strip fences, keep code content
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  // 2. Image references: remove entirely
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // 3. Links: keep display text, drop URL
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // 4. Table separator rows: remove
  result = result.replace(/^\|[\s:|-]+\|$/gm, '');
  // 5. Table data rows: pipe → space
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split('|').map((c: string) => c.trim()).join('  '),
  );
  // 6. Bold / italic
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
  result = result.replace(/\*([^*]+)\*/g, '$1');
  result = result.replace(/__([^_]+)__/g, '$1');
  result = result.replace(/_([^_]+)_/g, '$1');
  // 7. Headings: strip # prefix
  result = result.replace(/^#{1,6}\s+/gm, '');
  // 8. Inline code
  result = result.replace(/`([^`]+)`/g, '$1');
  // 9. Horizontal rules
  result = result.replace(/^[-*_]{3,}\s*$/gm, '');
  // 10. Blockquotes: strip > prefix
  result = result.replace(/^>\s?/gm, '');
  // 11. Unordered list markers
  result = result.replace(/^(\s*)[-*+]\s/gm, '$1• ');
  // 12. Collapse excessive blank lines
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------

export function createSender(api: WeChatApi, botAccountId: string) {
  let clientCounter = 0;

  function generateClientId(): string {
    return `wcc-${Date.now()}-${++clientCounter}`;
  }

  async function sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    const clientId = generateClientId();

    // Convert markdown to plain text before sending to WeChat
    const plainText = markdownToPlainText(text);

    const items: MessageItem[] = [
      {
        type: MessageItemType.TEXT,
        text_item: { text: plainText },
      },
    ];

    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };

    logger.info('Sending text message', { toUserId, clientId, textLength: plainText.length });
    await api.sendMessage({ msg });
    logger.info('Text message sent', { toUserId, clientId });
  }

  /**
   * Upload a local file to WeChat CDN and send it as a media message.
   * Handles images, files, and videos based on mediaType.
   */
  async function uploadAndSendMedia(
    toUserId: string,
    contextToken: string,
    filePath: string,
    mediaType: UploadMediaType,
  ): Promise<void> {
    const absPath = resolve(filePath);
    if (!existsSync(absPath)) {
      throw new Error(`File not found: ${absPath}`);
    }

    const fileData = readFileSync(absPath);
    const rawsize = fileData.length;
    const rawfilemd5 = createHash('md5').update(fileData).digest('hex');
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = randomBytes(16).toString('hex');
    const aeskey = randomBytes(16);
    const fileName = basename(absPath);

    // 1. Get upload URL
    const uploadResp = await api.getUploadUrl({
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString('hex'),
    });

    // 2. Encrypt and upload to CDN
    const downloadParam = await encryptAndUpload(
      fileData,
      uploadResp.upload_full_url,
      uploadResp.upload_param,
      filekey,
      aeskey,
    );

    // 3. Build media message item
    const aesKeyBase64 = aeskey.toString('base64');
    const clientId = generateClientId();
    let item: MessageItem;

    if (mediaType === UploadMediaType.IMAGE) {
      item = {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: downloadParam,
            aes_key: aesKeyBase64,
          },
          mid_size: filesize,
          encrypt_type: 1,
        },
      };
    } else if (mediaType === UploadMediaType.VIDEO) {
      item = {
        type: MessageItemType.VIDEO,
        video_item: {
          cdn_media: {
            encrypt_query_param: downloadParam,
            aes_key: aesKeyBase64,
          },
          video_size: filesize,
          encrypt_type: 1,
        },
      };
    } else {
      item = {
        type: MessageItemType.FILE,
        file_item: {
          cdn_media: {
            encrypt_query_param: downloadParam,
            aes_key: aesKeyBase64,
          },
          file_name: fileName,
          len: rawsize,
          encrypt_type: 1,
        },
      };
    }

    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: [item],
    };

    logger.info('Sending media message', { toUserId, clientId, mediaType, fileName });
    await api.sendMessage({ msg });
    logger.info('Media message sent', { toUserId, clientId, mediaType });
  }

  async function sendImage(toUserId: string, contextToken: string, filePath: string): Promise<void> {
    await uploadAndSendMedia(toUserId, contextToken, filePath, UploadMediaType.IMAGE);
  }

  async function sendFile(toUserId: string, contextToken: string, filePath: string): Promise<void> {
    await uploadAndSendMedia(toUserId, contextToken, filePath, UploadMediaType.FILE);
  }

  /**
   * Detect MIME type from file extension and send with appropriate media type.
   */
  async function sendMediaAuto(toUserId: string, contextToken: string, filePath: string): Promise<void> {
    const ext = extname(filePath).toLowerCase();
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
    const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

    if (imageExts.includes(ext)) {
      await uploadAndSendMedia(toUserId, contextToken, filePath, UploadMediaType.IMAGE);
    } else if (videoExts.includes(ext)) {
      await uploadAndSendMedia(toUserId, contextToken, filePath, UploadMediaType.VIDEO);
    } else {
      await uploadAndSendMedia(toUserId, contextToken, filePath, UploadMediaType.FILE);
    }
  }

  return { sendText, sendImage, sendFile, sendMediaAuto };
}
