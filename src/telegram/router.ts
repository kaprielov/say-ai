import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import express from 'express';
import { verifyWebAppUser } from './webapp-auth.js';
import { translator } from './i18n.js';
import { keyForm } from './key-form.js';
import { QueryError } from '../queries/errors.js';
import { transaction } from '../knowledge-bases/service.js';
import type { TelegramService } from './service.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

export function telegramRouter(service: TelegramService) {
  const router = express.Router();
  router.get('/openai-key', (_request, response) => {
    const language = _request.query.lang === 'en' ? 'en' : 'ru';
    const nonce = randomBytes(18).toString('base64');
    response.set({
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}' https://telegram.org; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' https://web.telegram.org`,
    }).type('html').send(keyForm(language, nonce));
  });
  router.post('/openai-key', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (_request.get('origin') !== new URL(service.config.publicUrl).origin) { response.sendStatus(403); return; }
    next();
  }, express.json({ limit: '24kb' }), async (request, response) => {
    let t = translator(request.body?.language === 'en' ? 'en' : 'ru');
    try {
      const user = verifyWebAppUser(request.body?.initData, service.config.token);
      t = await service.localeFromPool(user);
      if (!service.credentials) throw new QueryError(503, 'key_check_unavailable', 'OpenAI could not validate this key. Try again shortly.');
      const session = await service.pool.query('SELECT language FROM telegram_sessions WHERE user_id = $1', [user]);
      if (!session.rows[0]?.language) throw new QueryError(401, 'invalid_telegram_session', 'Open this form from the manager again.');
      const owner = `telegram:${user}`;
      const admitted = await service.pool.query(`
        INSERT INTO openai_key_attempts (owner_id) VALUES ($1)
        ON CONFLICT (owner_id) DO UPDATE SET
          attempts = CASE WHEN openai_key_attempts.window_start < now() - interval '1 minute' THEN 1 ELSE openai_key_attempts.attempts + 1 END,
          window_start = CASE WHEN openai_key_attempts.window_start < now() - interval '1 minute' THEN now() ELSE openai_key_attempts.window_start END
        WHERE openai_key_attempts.window_start < now() - interval '1 minute' OR openai_key_attempts.attempts < 3 RETURNING owner_id
      `, [owner]);
      if (!admitted.rows[0]) throw new QueryError(429, 'key_check_limit', 'Too many key checks. Try again in one minute.');
      const key = request.body?.key;
      if (typeof key !== 'string') throw new QueryError(400, 'invalid_openai_key', 'Enter a valid OpenAI API key.');
      await service.credentials.validate(key);
      await service.credentials.save(owner, key);
      // Only the confirmation and menu enter the Telegram queue, never the credential.
      await transaction(service.pool, async db => {
        await service.enqueue(db, service.config.managerId, user, t('OpenAI key saved. You can now create knowledge bases and bots.'));
        await service.menu(db, user);
      });
      response.json({ saved: true });
    } catch (error) {
      if (!(error instanceof QueryError)) throw error;
      response.status(error.status).json({ error: { code: error.code, message: t(error.message) } });
    } finally { if (request.body) { delete request.body.key; delete request.body.initData; } }
  });

  router.post('/webhook/:botId', async (request, response, next) => {
    try {
      const botId = request.params.botId;
      if (!/^\d{1,16}$/.test(botId)) { response.sendStatus(404); return; }
      const expected = botId === service.config.managerId ? service.config.webhookSecret
        : (await service.pool.query('SELECT webhook_secret FROM telegram_bots WHERE id = $1', [botId])).rows[0]?.webhook_secret;
      if (!expected || !timingSafeEqual(digest(request.get('X-Telegram-Bot-Api-Secret-Token') ?? ''), digest(expected))) {
        response.sendStatus(401); return;
      }
      next();
    } catch (error) { next(error); }
  }, express.json({ limit: '2mb' }), async (request, response) => {
    const update = request.body;
    if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) { response.sendStatus(400); return; }
    // A pasted credential is never persisted in the general update queue.
    if (request.params.botId === service.config.managerId && typeof update.message?.text === 'string'
      && /\bsk-[A-Za-z0-9_-]{16,512}\b/.test(update.message.text)) {
      update.message.text = '/openai';
      update.message.key_redacted = true;
    }
    const pending = [update];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== 'object') continue;
      for (const key of Object.keys(value)) {
        if (typeof value[key] === 'string') value[key] = value[key].replace(/\bsk-[A-Za-z0-9_-]{16,512}\b/g, '[redacted credential]');
        else if (value[key] && typeof value[key] === 'object') pending.push(value[key]);
      }
    }
    await service.pool.query(`
      INSERT INTO telegram_updates (bot_id, update_id, payload) VALUES ($1, $2, $3)
      ON CONFLICT (bot_id, update_id) DO NOTHING
    `, [request.params.botId, update.update_id, update]);
    response.sendStatus(200);
  });
  return router;
}
