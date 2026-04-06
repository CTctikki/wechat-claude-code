import { WeChatApi } from './api.js';
import { TypingStatus } from './types.js';
import { logger } from '../logger.js';

const KEEPALIVE_INTERVAL_MS = 5_000;
const TICKET_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CachedTicket {
  ticket: string;
  expiresAt: number;
}

/**
 * Manages WeChat typing indicators ("对方正在输入…").
 *
 * - Retrieves typing tickets from getConfig, caches for ~24h (randomised)
 * - Sends TYPING status every 5s while active
 * - All errors are silently swallowed (fire-and-forget)
 */
export function createTypingManager(api: WeChatApi) {
  const ticketCache = new Map<string, CachedTicket>();

  async function getTicket(userId: string, contextToken?: string): Promise<string | null> {
    // Check cache
    const cached = ticketCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.ticket;
    }

    // Fetch from server
    try {
      const resp = await api.getConfig(userId, contextToken);
      if (resp.typing_ticket) {
        // Randomise TTL to prevent thundering herd
        const jitter = Math.random() * TICKET_TTL_MS;
        ticketCache.set(userId, {
          ticket: resp.typing_ticket,
          expiresAt: Date.now() + jitter,
        });
        return resp.typing_ticket;
      }
    } catch (err) {
      logger.debug('Failed to get typing ticket (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }

  /**
   * Start showing "正在输入…" to the user.
   * Returns a stop function that cancels the indicator.
   *
   * Safe to call even if ticket retrieval fails — becomes a no-op.
   */
  async function startTyping(
    userId: string,
    contextToken?: string,
  ): Promise<() => void> {
    const ticket = await getTicket(userId, contextToken);

    if (!ticket) {
      // No ticket available — return a no-op stop function
      return () => {};
    }

    // Send initial TYPING status
    api.sendTyping({ ilink_user_id: userId, typing_ticket: ticket, status: TypingStatus.TYPING });

    // Keepalive: resend TYPING every 5 seconds
    const interval = setInterval(() => {
      api.sendTyping({ ilink_user_id: userId, typing_ticket: ticket, status: TypingStatus.TYPING });
    }, KEEPALIVE_INTERVAL_MS);

    let stopped = false;

    return () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      // Send CANCEL to remove indicator
      api.sendTyping({ ilink_user_id: userId, typing_ticket: ticket, status: TypingStatus.CANCEL });
    };
  }

  return { startTyping };
}
