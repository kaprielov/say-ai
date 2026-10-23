import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { QueryError } from '../queries/errors.js';

export class TelegramError extends Error {
  constructor(public readonly code: number, public readonly retryAfter = 10) {
    super('Telegram request failed.');
  }
}

export interface TelegramTransport {
  call<T = unknown>(token: string, method: string, payload?: object): Promise<T>;
  download(token: string, fileId: string): Promise<Buffer>;
}

export class TelegramClient implements TelegramTransport {
  async call<T = unknown>(token: string, method: string, payload: object = {}): Promise<T> {
    // Do not propagate transport errors: their URLs can contain bot tokens.
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json() as { ok: boolean; result: T; error_code?: number; parameters?: { retry_after?: number } };
      if (!body.ok) throw new TelegramError(body.error_code ?? response.status, body.parameters?.retry_after);
      return body.result;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw new TelegramError(502);
    }
  }

  async download(token: string, fileId: string) {
    const file = await this.call<{ file_path?: string; file_size?: number }>(token, 'getFile', { file_id: fileId });
    if (!file.file_path || (file.file_size ?? 0) > 1024 * 1024) {
      throw new QueryError(413, 'payload_too_large', 'File must not exceed 1 MiB.');
    }
    try {
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok || !response.body) throw new TelegramError(502);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new QueryError(413, 'payload_too_large', 'File must not exceed 1 MiB.');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof QueryError || error instanceof TelegramError) throw error;
      throw new TelegramError(502);
    }
  }
}

export function encryptToken(token: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decryptToken(value: string, key: Buffer) {
  const bytes = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
