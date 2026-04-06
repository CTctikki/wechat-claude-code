import { decryptAesEcb, encryptAesEcb } from "./crypto.js";
import { logger } from "../logger.js";
import { CDN_BASE_URL } from "./accounts.js";

export function buildCdnDownloadUrl(encryptQueryParam: string): string {
  if (!/^[A-Za-z0-9%=&+._~\-/]+$/.test(encryptQueryParam)) {
    throw new Error('Invalid CDN query parameter');
  }
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

export function buildCdnUploadUrl(uploadParam: string, filekey: string): string {
  return `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

export async function downloadAndDecrypt(
  encryptQueryParam: string,
  aesKeyBase64: string,
): Promise<Buffer> {
  const url = buildCdnDownloadUrl(encryptQueryParam);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`CDN download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`CDN download failed: ${response.status} ${response.statusText}`);
  }

  const encrypted = Buffer.from(await response.arrayBuffer());

  // Handle both formats:
  // 1. base64-of-raw-16-bytes (16 raw bytes encoded as base64)
  // 2. base64-of-hex-string (32 hex chars encoded as base64)
  let aesKey: Buffer;
  const raw = Buffer.from(aesKeyBase64, "base64");

  if (raw.length === 16) {
    // base64-of-raw-16-bytes
    aesKey = raw;
  } else {
    // base64-of-hex-string: decode the string as hex to get the 16-byte key
    const hexStr = raw.toString("utf-8");
    aesKey = Buffer.from(hexStr, "hex");
  }

  const decrypted = decryptAesEcb(aesKey, encrypted);
  logger.info("CDN download and decrypt succeeded", { size: decrypted.length });

  return decrypted;
}

/**
 * Encrypt a buffer and upload it to the WeChat CDN.
 * Returns the download parameter from the `x-encrypted-param` response header.
 */
export async function encryptAndUpload(
  data: Buffer,
  uploadFullUrl: string | undefined,
  uploadParam: string | undefined,
  filekey: string,
  aeskey: Buffer,
): Promise<string> {
  // Encrypt data
  const ciphertext = encryptAesEcb(aeskey, data);

  // Resolve upload URL
  let url: string;
  if (uploadFullUrl) {
    url = uploadFullUrl;
  } else if (uploadParam) {
    url = buildCdnUploadUrl(uploadParam, filekey);
  } else {
    throw new Error('No upload URL available (neither upload_full_url nor upload_param)');
  }

  // Upload with retry
  const MAX_RETRIES = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.status >= 400 && response.status < 500) {
        // Client error — don't retry
        throw new Error(`CDN upload client error: ${response.status}`);
      }

      if (!response.ok) {
        throw new Error(`CDN upload failed: ${response.status}`);
      }

      // Extract download param from response header
      const downloadParam = response.headers.get('x-encrypted-param');
      if (!downloadParam) {
        throw new Error('CDN upload response missing x-encrypted-param header');
      }

      logger.info('CDN upload succeeded', { size: ciphertext.length, attempt });
      return downloadParam;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Don't retry on client errors
      if (lastError.message.includes('client error')) throw lastError;
      logger.warn('CDN upload attempt failed', { attempt, error: lastError.message });
    }
  }

  throw lastError ?? new Error('CDN upload failed after retries');
}
