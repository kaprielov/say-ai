import { createHmac, timingSafeEqual } from 'node:crypto';
import { QueryError } from '../queries/errors.js';

export function verifyWebAppUser(initData: unknown, token: string, now = Date.now()) {
  const unauthorized = () => new QueryError(401, 'invalid_telegram_session', 'Open this form from the manager again.');
  if (typeof initData !== 'string' || initData.length > 16_384) throw unauthorized();
  const values = new URLSearchParams(initData);
  if (new Set(values.keys()).size !== [...values.keys()].length) throw unauthorized();
  const hash = values.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw unauthorized();
  values.delete('hash');
  const data = [...values.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(data).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw unauthorized();
  const date = Number(values.get('auth_date'));
  if (!Number.isSafeInteger(date) || date * 1000 > now + 30_000 || now - date * 1000 > 10 * 60_000) throw unauthorized();
  try {
    const user = JSON.parse(values.get('user') ?? 'null');
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot) throw unauthorized();
    return user.id as number;
  } catch { throw unauthorized(); }
}
