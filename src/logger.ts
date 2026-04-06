import { mkdirSync, appendFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./constants.js";

const LOG_DIR = join(DATA_DIR, "logs");
const MAX_LOG_FILES = 30; // Keep at most 30 days of logs
const DEBUG_ENABLED = process.env.WCC_DEBUG === "1";

let logDirEnsured = false;

/** Clean up old log files beyond MAX_LOG_FILES retention. */
function cleanupOldLogs(): void {
  try {
    const files = readdirSync(LOG_DIR)
      .filter((f) => f.startsWith("bridge-") && f.endsWith(".log"))
      .sort();
    while (files.length > MAX_LOG_FILES) {
      unlinkSync(join(LOG_DIR, files.shift()!));
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Redact sensitive values from a string:
 * - Bearer tokens (Authorization headers)
 * - aes_key values
 * - context_token, bot_token, typing_ticket, and other sensitive fields
 * - generic token/secret values in JSON payloads
 */
export function redact(obj: unknown): string {
  const raw = typeof obj === "string" ? obj : JSON.stringify(obj);
  if (!raw) return raw;

  let safe = raw;
  // Mask Bearer tokens: "Bearer <anything>"
  safe = safe.replace(/Bearer\s+[^\s"\\]+/gi, "Bearer ***");
  // Mask sensitive field values in JSON (context_token, bot_token, typing_ticket, etc.)
  safe = safe.replace(
    /"(?:(?:[\w]+_)?token|secret|password|api_key|bot_token|context_token|typing_ticket|aes_key|aeskey)"\s*:\s*"[^"]*"/gi,
    (match) => {
      const key = match.match(/"[^"]*"/)?.[0] ?? '""';
      return `${key}: "***"`;
    },
  );
  // Mask CDN query params that may contain tokens
  safe = safe.replace(/encrypted_query_param=[^\s&"]+/gi, "encrypted_query_param=***");
  return safe;
}

function ensureLogDir(): void {
  if (logDirEnsured) return;
  mkdirSync(LOG_DIR, { recursive: true });
  cleanupOldLogs();
  logDirEnsured = true;
}

function getLogFilePath(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return join(LOG_DIR, `bridge-${date}.log`);
}

function writeLogLine(level: string, message: string, data?: unknown): void {
  ensureLogDir();
  const timestamp = new Date().toISOString();
  const parts = [timestamp, level, message];
  if (data !== undefined) {
    parts.push(redact(data));
  }
  const line = parts.join(" ") + "\n";
  try {
    appendFileSync(getLogFilePath(), line, "utf-8");
  } catch {
    // Best-effort logging — never crash on write failure
  }
}

export const logger = {
  info(message: string, data?: unknown): void {
    writeLogLine("INFO", message, data);
  },
  warn(message: string, data?: unknown): void {
    writeLogLine("WARN", message, data);
  },
  error(message: string, data?: unknown): void {
    writeLogLine("ERROR", message, data);
  },
  debug(message: string, data?: unknown): void {
    if (DEBUG_ENABLED) {
      writeLogLine("DEBUG", message, data);
    }
  },
} as const;
