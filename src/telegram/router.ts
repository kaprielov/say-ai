import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { TelegramService } from './service.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

export function telegramRouter(service: TelegramService) {
  const router = express.Router();
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
    await service.pool.query(`
      INSERT INTO telegram_updates (bot_id, update_id, payload) VALUES ($1, $2, $3)
      ON CONFLICT (bot_id, update_id) DO NOTHING
    `, [request.params.botId, update.update_id, update]);
    response.sendStatus(200);
  });
  return router;
}
