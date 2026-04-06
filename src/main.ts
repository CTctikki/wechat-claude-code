import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { unlinkSync, writeFileSync, mkdirSync } from 'node:fs';

import { WeChatApi } from './wechat/api.js';
import { saveAccount, loadLatestAccount, type AccountData } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { downloadImage, extractText, extractFirstImageUrl, extractAllImageItems, extractVoiceText, extractFirstVoiceItem, extractFirstFileItem, downloadFile, extractRefMessage } from './wechat/media.js';
import { createTypingManager } from './wechat/typing.js';
import { createSessionStore, type Session } from './session.js';
import { createPermissionBroker } from './permission.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { claudeQuery, type QueryOptions } from './claude/provider.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { DATA_DIR } from './constants.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { resolve as resolvePath, extname } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 2048;

function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }
  return chunks;
}

function promptUser(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/** Open a file using the platform's default application (secure: uses spawnSync) */
function openFile(filePath: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    // Linux: try xdg-open
    cmd = 'xdg-open';
    args = [filePath];
  }

  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function runSetup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const QR_PATH = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置...\n');

  // Loop: generate QR → display → poll for scan → handle expiry → repeat
  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();

    const isHeadlessLinux = process.platform === 'linux' &&
      !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

    if (isHeadlessLinux) {
      // Headless Linux: display QR in terminal using qrcode-terminal
      try {
        const qrcodeTerminal = await import('qrcode-terminal');
        console.log('请用微信扫描下方二维码：\n');
        qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
        console.log();
        console.log('二维码链接：', qrcodeUrl);
        console.log();
      } catch {
        logger.warn('qrcode-terminal not available, falling back to URL');
        console.log('无法在终端显示二维码，请访问链接：');
        console.log(qrcodeUrl);
        console.log();
      }
    } else {
      // macOS / Windows / GUI Linux: generate QR PNG and open with system viewer
      const QRCode = await import('qrcode');
      const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
      writeFileSync(QR_PATH, pngData);

      openFile(QR_PATH);
      console.log('已打开二维码图片，请用微信扫描：');
      console.log(`图片路径: ${QR_PATH}\n`);
    }

    console.log('等待扫码绑定...');

    try {
      await waitForQrScan(qrcodeId);
      console.log('✅ 绑定成功!');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        console.log('⚠️ 二维码已过期，正在刷新...\n');
        continue;
      }
      throw err;
    }
  }

  // Clean up QR image
  try { unlinkSync(QR_PATH); } catch {
    logger.warn('Failed to clean up QR image', { path: QR_PATH });
  }

  const workingDir = await promptUser('请输入工作目录', process.cwd());
  const config = loadConfig();
  config.workingDirectory = workingDir;
  saveConfig(config);

  console.log('运行 npm run daemon -- start 启动服务');
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const account = loadLatestAccount();

  if (!account) {
    console.error('未找到账号，请先运行 node dist/main.js setup');
    process.exit(1);
  }

  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sessionStore = createSessionStore();
  const session: Session = sessionStore.load(account.accountId);

  // Fix: backfill session workingDirectory from config if it's still the default process.cwd()
  if (config.workingDirectory && session.workingDirectory === process.cwd()) {
    session.workingDirectory = config.workingDirectory;
    sessionStore.save(account.accountId, session);
  }

  // Fix: reset stale non-idle state on startup (e.g. after crash)
  if (session.state !== 'idle') {
    logger.warn('Resetting stale session state on startup', { state: session.state });
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  }

  const sender = createSender(api, account.accountId);
  const typingManager = createTypingManager(api);
  const sharedCtx = { lastContextToken: session.lastContextToken ?? '' };
  const activeControllers = new Map<string, { controller: AbortController; startedAt: number }>();
  const permissionBroker = createPermissionBroker(async () => {
    try {
      await sender.sendText(account.userId ?? '', sharedCtx.lastContextToken, '⏰ 权限请求超时，已自动拒绝。');
    } catch {
      logger.warn('Failed to send permission timeout message');
    }
  });

  // -- Wire the monitor callbacks --

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      await handleMessage(msg, account, session, sessionStore, permissionBroker, sender, config, sharedCtx, activeControllers, typingManager);
    },
    onSessionExpired: () => {
      logger.warn('Session expired, will keep retrying...');
      console.error('⚠️ 微信会话已过期，请重新运行 setup 扫码绑定');
    },
  };

  const monitor = createMonitor(api, callbacks);

  // -- Graceful shutdown --

  function shutdown(): void {
    logger.info('Shutting down...');
    monitor.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { accountId: account.accountId });
  console.log(`已启动 (账号: ${account.accountId})`);

  await monitor.run();
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: WeixinMessage,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  permissionBroker: ReturnType<typeof createPermissionBroker>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  sharedCtx: { lastContextToken: string },
  activeControllers: Map<string, { controller: AbortController; startedAt: number }>,
  typingManager: ReturnType<typeof createTypingManager>,
): Promise<void> {
  // Filter: only user messages with required fields
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;
  sharedCtx.lastContextToken = contextToken;
  // Persist context token to session for restart recovery
  if (contextToken && session.lastContextToken !== contextToken) {
    session.lastContextToken = contextToken;
    sessionStore.save(account.accountId, session);
  }

  // Extract text from items
  let userText = extractTextFromItems(msg.item_list);
  const imageItems = extractAllImageItems(msg.item_list);

  // Debug: log item types to help diagnose unsupported message issues
  logger.info('Message items received', {
    itemTypes: msg.item_list.map(i => i.type),
    hasText: !!userText,
    imageCount: imageItems.length,
  });

  // Voice message support: use server-side speech-to-text if available
  const voiceItem = extractFirstVoiceItem(msg.item_list);
  if (voiceItem && !userText) {
    const voiceText = extractVoiceText(voiceItem);
    logger.info('Voice message received', {
      hasVoiceText: !!voiceText,
      voiceTextLength: voiceText?.length ?? 0,
      voiceItemKeys: Object.keys(voiceItem.voice_item ?? {}),
    });
    if (voiceText) {
      userText = `[语音消息] ${voiceText}`;
    } else {
      // No STT result — tell user to retry; don't fall through to "unsupported"
      userText = '[语音消息] (语音识别未返回文字，请尝试重新发送或改用文字输入)';
    }
  }

  // File message support: download and provide to Claude
  const fileItem = extractFirstFileItem(msg.item_list);

  // Quoted/referenced message support: prepend context
  const ref = extractRefMessage(msg.item_list);
  if (ref) {
    userText = ref.prefix + (userText ? '\n' + userText : '');
    // If quoted message has media and we have no images, use the referenced media
    if (ref.mediaItem && imageItems.length === 0) {
      imageItems.push(ref.mediaItem);
    }
  }

  // Concurrency guard: abort current query when new message arrives
  const QUERY_GRACE_PERIOD_MS = 5_000; // don't abort queries younger than 5s
  if (session.state === 'processing') {
    if (userText.startsWith('/clear')) {
      // Force reset stuck session state
      const active = activeControllers.get(account.accountId);
      if (active) { active.controller.abort(); activeControllers.delete(account.accountId); }
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      // Fall through to command routing so /clear executes normally
    } else if (!userText.startsWith('/')) {
      const active = activeControllers.get(account.accountId);
      if (active && Date.now() - active.startedAt < QUERY_GRACE_PERIOD_MS) {
        // Query just started (e.g. downloading images) — don't abort, drop this message
        logger.info('Ignoring message during query grace period', {
          elapsed: Date.now() - active.startedAt,
        });
        return;
      }
      // Abort the current query and process the new message instead
      if (active) { active.controller.abort(); activeControllers.delete(account.accountId); }
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      // Fall through to send new message to Claude
    } else if (!userText.startsWith('/status') && !userText.startsWith('/help')) {
      return;
    }
  }

  // -- Grace period: catch late y/n after timeout --

  if (session.state === 'idle' && permissionBroker.isTimedOut(account.accountId)) {
    const lower = userText.toLowerCase();
    if (lower === 'y' || lower === 'yes' || lower === 'n' || lower === 'no') {
      permissionBroker.clearTimedOut(account.accountId);
      await sender.sendText(fromUserId, contextToken, '⏰ 权限请求已超时，请重新发送你的请求。');
      return;
    }
  }

  // -- Permission state handling --

  if (session.state === 'waiting_permission') {
    // Check if there's actually a pending permission (may be lost after restart)
    const pendingPerm = permissionBroker.getPending(account.accountId);
    if (!pendingPerm) {
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      await sender.sendText(fromUserId, contextToken, '⚠️ 权限请求已失效（可能因服务重启），请重新发送你的请求。');
      return;
    }

    const lower = userText.toLowerCase();
    if (lower === 'y' || lower === 'yes') {
      const resolved = permissionBroker.resolvePermission(account.accountId, true);
      await sender.sendText(fromUserId, contextToken, resolved ? '✅ 已允许' : '⚠️ 权限请求处理失败，可能已超时');
    } else if (lower === 'n' || lower === 'no') {
      const resolved = permissionBroker.resolvePermission(account.accountId, false);
      await sender.sendText(fromUserId, contextToken, resolved ? '❌ 已拒绝' : '⚠️ 权限请求处理失败，可能已超时');
    } else {
      await sender.sendText(fromUserId, contextToken, '正在等待权限审批，请回复 y 或 n。');
    }
    return;
  }

  // -- Command routing --

  if (userText.startsWith('/')) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(account.accountId, session);
    };

    const ctx: CommandContext = {
      accountId: account.accountId,
      session,
      updateSession,
      clearSession: () => sessionStore.clear(account.accountId),
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      rejectPendingPermission: () => permissionBroker.rejectPending(account.accountId),
      text: userText,
    };

    const result: CommandResult = routeCommand(ctx);

    if (result.handled && result.reply) {
      await sender.sendText(fromUserId, contextToken, result.reply);
      return;
    }

    if (result.handled && result.claudePrompt) {
      // Fall through to send the claudePrompt to Claude
      await sendToClaude(
        result.claudePrompt,
        imageItems,
        fromUserId,
        contextToken,
        account,
        session,
        sessionStore,
        permissionBroker,
        sender,
        config,
        activeControllers,
        typingManager,
      );
      return;
    }

    if (result.handled) {
      // Handled but no reply and no claudePrompt (shouldn't normally happen)
      return;
    }

    // Not handled, treat as normal message (fall through)
  }

  // -- Normal message -> Claude --

  // Handle file messages: download and prepend file info to user text
  if (fileItem && !userText && imageItems.length === 0) {
    const fileData = await downloadFile(fileItem);
    if (fileData) {
      const isTextFile = fileData.mimeType.startsWith('text/') ||
        ['application/json', 'application/xml', 'application/javascript'].includes(fileData.mimeType);
      if (isTextFile && fileData.data.length < 100_000) {
        // Small text files: inline content directly
        const content = fileData.data.toString('utf-8');
        userText = `[文件: ${fileData.fileName}]\n\n${content}`;
      } else {
        // Binary or large files: save to temp and tell Claude the path
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { join, resolve } = await import('node:path');
        const { tmpdir } = await import('node:os');
        const tempDir = join(tmpdir(), 'wechat-claude-code');
        mkdirSync(tempDir, { recursive: true });
        const tempPath = join(tempDir, fileData.fileName);
        writeFileSync(tempPath, fileData.data);
        userText = `用户发送了文件: ${fileData.fileName} (${fileData.mimeType}, ${fileData.data.length} bytes)\n文件已保存到: ${resolve(tempPath)}\n请分析这个文件。`;
      }
    } else {
      await sender.sendText(fromUserId, contextToken, '⚠️ 文件下载失败，请重试。');
      return;
    }
  }

  if (!userText && imageItems.length === 0) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字、图片、语音或文件');
    return;
  }

  await sendToClaude(
    userText,
    imageItems,
    fromUserId,
    contextToken,
    account,
    session,
    sessionStore,
    permissionBroker,
    sender,
    config,
    activeControllers,
    typingManager,
  );
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

async function sendToClaude(
  userText: string,
  imageItems: import('./wechat/types.js').MessageItem[],
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  permissionBroker: ReturnType<typeof createPermissionBroker>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, { controller: AbortController; startedAt: number }>,
  typingManager: ReturnType<typeof createTypingManager>,
): Promise<void> {
  // Set state to processing
  session.state = 'processing';
  sessionStore.save(account.accountId, session);

  // Create abort controller for this query so it can be cancelled by new messages
  const abortController = new AbortController();
  activeControllers.set(account.accountId, { controller: abortController, startedAt: Date.now() });

  // Record user message in chat history
  sessionStore.addChatMessage(session, 'user', userText || '(图片)');

  // Start typing indicator ("对方正在输入…")
  const stopTyping = await typingManager.startTyping(fromUserId, contextToken);
  let typingStopped = false;
  const ensureTypingStopped = () => {
    if (!typingStopped) { typingStopped = true; stopTyping(); }
  };

  try {
    // Download images if present — save to temp files for Claude to read
    // (The SDK's stdin transport doesn't pass image content blocks to the CLI process,
    //  so we save images as files and reference them in the prompt instead.)
    const imagePaths: string[] = [];
    if (imageItems.length > 0) {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const imgDir = join(homedir(), '.wechat-claude-code', 'images');
      try { mkdirSync(imgDir, { recursive: true }); } catch {}
      for (const imgItem of imageItems) {
        const base64DataUri = await downloadImage(imgItem);
        if (base64DataUri) {
          const matches = base64DataUri.match(/^data:([^;]+);base64,(.+)$/);
          if (matches) {
            const ext = matches[1].split('/')[1] || 'bin';
            const imgPath = join(imgDir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
            writeFileSync(imgPath, Buffer.from(matches[2], 'base64'));
            imagePaths.push(imgPath);
            logger.info('Image saved to temp file', { imgPath, size: matches[2].length });
          }
        }
      }
    }

    const effectivePermissionMode = session.permissionMode ?? config.permissionMode;
    const isAutoPermission = effectivePermissionMode === 'auto';

    // Map 'auto' to bypassPermissions — skips all permission checks in the SDK
    const sdkPermissionMode = isAutoPermission ? 'bypassPermissions' : effectivePermissionMode;

    // Unified buffer: text deltas and tool summaries all go here
    let pendingBuffer = '';
    let anySent = false;
    let lastSendTime = Date.now(); // start the clock now, so first delta doesn't fire immediately
    const SEND_INTERVAL_MS = 12_000;

    // Send everything in pendingBuffer. force=true ignores rate limit.
    async function trySend(force = false): Promise<void> {
      if (!pendingBuffer.trim()) return;
      const now = Date.now();
      if (!force && now - lastSendTime < SEND_INTERVAL_MS) return;
      const toSend = pendingBuffer.trim();
      pendingBuffer = '';
      const chunks = splitMessage(toSend);
      for (const chunk of chunks) {
        lastSendTime = Date.now();
        anySent = true;
        await sender.sendText(fromUserId, contextToken, chunk);
      }
    }

    // Build prompt: if images were saved, prepend file paths so Claude can read them
    let effectivePrompt = userText || '';
    if (imagePaths.length > 0) {
      const imageInstructions = imagePaths.length === 1
        ? `[用户发送了一张图片，已保存到: ${imagePaths[0]}，请先用 Read 工具读取这张图片再回复]`
        : `[用户发送了 ${imagePaths.length} 张图片，已保存到:\n${imagePaths.map(p => `  - ${p}`).join('\n')}\n请先用 Read 工具读取这些图片再回复]`;
      effectivePrompt = imageInstructions + (effectivePrompt ? '\n' + effectivePrompt : '\n请分析这张图片');
    }

    const queryOptions: QueryOptions = {
      prompt: effectivePrompt,
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir()),
      resume: imagePaths.length > 0 ? undefined : session.sdkSessionId,
      model: session.model,
      systemPrompt: config.systemPrompt,
      permissionMode: sdkPermissionMode,
      abortController,
      onText: async (delta: string) => {
        ensureTypingStopped(); // Stop "typing..." once text starts flowing
        pendingBuffer += delta;
        await trySend();
      },
      onThinking: async (summary: string) => {
        ensureTypingStopped(); // Stop "typing..." when tool calls appear
        pendingBuffer += (pendingBuffer ? '\n' : '') + summary;
        await trySend();
      },
      onPermissionRequest: isAutoPermission
        ? async () => true  // auto-approve all tools, skip broker
        : async (toolName: string, toolInput: string) => {
            // Set state to waiting_permission
            session.state = 'waiting_permission';
            sessionStore.save(account.accountId, session);

            // Create pending permission
            const permissionPromise = permissionBroker.createPending(
              account.accountId,
              toolName,
              toolInput,
            );

            // Send permission message to WeChat
            const perm = permissionBroker.getPending(account.accountId);
            if (perm) {
              const permMsg = permissionBroker.formatPendingMessage(perm);
              await sender.sendText(fromUserId, contextToken, permMsg);
            }

            const allowed = await permissionPromise;

            // Reset state after permission resolved
            session.state = 'processing';
            sessionStore.save(account.accountId, session);

            return allowed;
          },
    };

    let result = await claudeQuery(queryOptions);

    // If resume failed (e.g. corrupted session), retry without resume
    if (result.error && queryOptions.resume) {
      logger.warn('Resume failed, retrying without resume', { error: result.error, sessionId: queryOptions.resume });
      queryOptions.resume = undefined;
      session.sdkSessionId = undefined;
      sessionStore.save(account.accountId, session);
      // Create a fresh AbortController — the previous one may already be aborted
      const freshController = new AbortController();
      activeControllers.set(account.accountId, { controller: freshController, startedAt: Date.now() });
      queryOptions.abortController = freshController;
      const retryResult = await claudeQuery(queryOptions);
      result = retryResult;
    }

    // Flush any remaining buffered content
    await trySend(true);

    // Send result back to WeChat
    if (result.text) {
      if (result.error) {
        logger.warn('Claude query had error but returned text, using text', { error: result.error });
      }
      sessionStore.addChatMessage(session, 'assistant', result.text);
      // If nothing was streamed at all (e.g. streaming not supported), send full text now
      if (!anySent) {
        const chunks = splitMessage(result.text);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
      }
    } else if (result.error) {
      logger.error('Claude query error', { error: result.error });
      await sender.sendText(fromUserId, contextToken, '⚠️ Claude 处理请求时出错，请稍后重试。');
    } else if (!anySent) {
      await sender.sendText(fromUserId, contextToken, 'ℹ️ Claude 无返回内容（可能因权限被拒而终止）');
    }

    // Post-processing: detect file paths in Claude's output and send as media
    if (result.text) {
      await sendDetectedFiles(result.text, fromUserId, contextToken, sender);
    }

    // Update session with new SDK session ID
    session.sdkSessionId = result.sessionId || undefined;
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
    if (isAbort) {
      // Query was cancelled by a new incoming message — exit silently
      logger.info('Claude query aborted by new message');
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Error in sendToClaude', { error: errorMsg });
      await sender.sendText(fromUserId, contextToken, '⚠️ 处理消息时出错，请稍后重试。');
    }
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  } finally {
    // Always stop typing indicator
    ensureTypingStopped();
    // Clean up the abort controller if it's still ours
    const active = activeControllers.get(account.accountId);
    if (active && active.controller === abortController) {
      activeControllers.delete(account.accountId);
    }
  }
}

// ---------------------------------------------------------------------------
// File detection & media sending helper
// ---------------------------------------------------------------------------

/** Media file extensions that should be sent back to WeChat automatically */
const MEDIA_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
  '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz',
  '.csv',
]);

/**
 * Detect file paths in Claude's output that look like generated/saved files
 * and send them back to WeChat as media messages.
 */
async function sendDetectedFiles(
  text: string,
  toUserId: string,
  contextToken: string,
  sender: ReturnType<typeof createSender>,
): Promise<void> {
  // Match common patterns like:
  // "saved to /path/to/file.png"  "写入 /path/to/file.csv"  "文件已保存到: /path/to/output.pdf"
  // Also match paths on their own lines, or in backticks
  const pathPatterns = [
    /(?:saved?|wrote|written|created|generated|output|保存|写入|生成|导出|输出)(?:\s+(?:to|at|in|到|至|:))?\s+[`"]?([^\s`"]+\.[a-zA-Z0-9]+)[`"]?/gi,
    /(?:文件已保存到|文件路径|File saved|Output file)[:\s]+[`"]?([^\s`"]+\.[a-zA-Z0-9]+)[`"]?/gi,
  ];

  const detectedPaths = new Set<string>();

  for (const pattern of pathPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const filePath = match[1];
      if (filePath && MEDIA_EXTENSIONS.has(extname(filePath).toLowerCase())) {
        detectedPaths.add(filePath);
      }
    }
  }

  for (const filePath of detectedPaths) {
    const absPath = resolvePath(filePath);
    if (existsSync(absPath)) {
      try {
        await sender.sendMediaAuto(toUserId, contextToken, absPath);
        logger.info('Auto-sent detected file', { path: absPath });
      } catch (err) {
        logger.warn('Failed to auto-send detected file', {
          path: absPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2];

if (command === 'setup') {
  runSetup().catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else {
  // 'start' or no argument
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}
