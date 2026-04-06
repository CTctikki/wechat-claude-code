import type {
  GetUpdatesResp,
  SendMessageReq,
  GetUploadUrlReq,
  GetUploadUrlResp,
  GetConfigResp,
  SendTypingReq,
} from './types.js';
import { logger } from '../logger.js';

/** Generate a random uint32 and return its base64 representation. */
function generateUin(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const view = new DataView(buf.buffer);
  const uint32 = view.getUint32(0, false); // big-endian
  return Buffer.from(buf).toString('base64');
}

export class WeChatApi {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly uin: string;

  constructor(token: string, baseUrl: string = 'https://ilinkai.weixin.qq.com') {
    if (baseUrl) {
      try {
        const url = new URL(baseUrl);
        const allowedHosts = ['weixin.qq.com', 'wechat.com'];
        const isAllowed = allowedHosts.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
        if (url.protocol !== 'https:' || !isAllowed) {
          logger.warn('Untrusted baseUrl, using default', { baseUrl });
          baseUrl = 'https://ilinkai.weixin.qq.com';
        }
      } catch {
        logger.warn('Invalid baseUrl, using default', { baseUrl });
        baseUrl = 'https://ilinkai.weixin.qq.com';
      }
    }
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.uin = generateUin();
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.token}`,
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': this.uin,
    };
  }

  private async request<T = Record<string, unknown>>(
    path: string,
    body: unknown,
    timeoutMs: number = 15_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const url = `${this.baseUrl}/${path}`;

    logger.debug('API request', { url, body });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const json = (await res.json()) as T;
      logger.debug('API response', json);
      return json;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Long-poll for new messages. Timeout adapts from server hint. */
  async getUpdates(buf?: string, timeoutMs: number = 35_000): Promise<GetUpdatesResp> {
    return this.request<GetUpdatesResp>(
      'ilink/bot/getupdates',
      buf ? { get_updates_buf: buf } : {},
      timeoutMs + 5_000, // add 5s buffer over poll timeout to avoid client-side abort
    );
  }

  /** Send a message to a user. Retries up to 3 times on rate-limit (ret: -2). */
  async sendMessage(req: SendMessageReq): Promise<void> {
    const MAX_RETRIES = 3;
    let delay = 10_000; // start with 10s backoff on rate-limit
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await this.request<{ ret?: number }>('ilink/bot/sendmessage', req);
      if ((res as any)?.ret === -2) {
        if (attempt === MAX_RETRIES) {
          logger.warn('sendMessage rate-limited after max retries', { attempts: MAX_RETRIES });
          return; // give up silently rather than crash
        }
        logger.warn('sendMessage rate-limited (ret:-2), retrying', { attempt, delayMs: delay });
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 60_000); // exponential backoff, cap at 60s
        continue;
      }
      return;
    }
  }

  /** Get a presigned upload URL for media files. */
  async getUploadUrl(req: GetUploadUrlReq): Promise<GetUploadUrlResp> {
    return this.request<GetUploadUrlResp>(
      'ilink/bot/getuploadurl',
      req,
    );
  }

  /** Get bot config (typing ticket) for a user. Timeout 10s. */
  async getConfig(userId: string, contextToken?: string): Promise<GetConfigResp> {
    return this.request<GetConfigResp>(
      'ilink/bot/getconfig',
      { ilink_user_id: userId, ...(contextToken ? { context_token: contextToken } : {}) },
      10_000,
    );
  }

  /** Send typing indicator. Fire-and-forget: errors are logged but never thrown. */
  async sendTyping(req: SendTypingReq): Promise<void> {
    try {
      await this.request<{ ret?: number }>(
        'ilink/bot/sendtyping',
        req,
        10_000,
      );
    } catch (err) {
      logger.debug('sendTyping error (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
