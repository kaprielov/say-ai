import { cleanupUploadDrafts } from './uploads.js';
import { setTimeout } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { QueryError } from '../queries/errors.js';
import { TelegramError, decryptToken } from './client.js';
import type { TelegramService, Update } from './service.js';
import { protectionSettings } from './protection.js';
import { webhookDelivery } from './webhook-delivery.js';
import { WorkerProgress } from '../worker-progress.js';

export async function processUpdate(service: TelegramService, db: PoolClient) {
  await db.query('BEGIN');
  try {
    const row = (await db.query<{ id: string; bot_id: string; payload: Update; attempts: number; ready: boolean }>(`
      SELECT u.*, true AS ready FROM telegram_updates u
      LEFT JOIN telegram_queue_turns turns ON turns.bot_id=u.bot_id
      WHERE NOT u.done AND u.available_at <= clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM telegram_updates earlier WHERE earlier.bot_id=u.bot_id AND NOT earlier.done AND earlier.id<u.id)
      ORDER BY COALESCE(turns.last_served,'-infinity'::timestamptz),u.id LIMIT 1 FOR UPDATE OF u
    `)).rows[0];
    if (!row || !row.ready) { await db.query('COMMIT'); return false; }
    await db.query('SAVEPOINT handling');
    try {
      await service.handle(db, row.bot_id, row.payload);
      await db.query('UPDATE telegram_updates SET done = true, payload = NULL WHERE id = $1', [row.id]);
    } catch (error) {
      await db.query('ROLLBACK TO SAVEPOINT handling');
      const terminal = error instanceof QueryError || row.attempts >= 2 || (error instanceof TelegramError && [400, 401, 403, 404].includes(error.code));
      if (terminal) {
        const message = row.payload.callback_query?.message ?? row.payload.message;
        const sender = row.payload.callback_query?.from ?? row.payload.message?.from;
        if (message?.chat.type === 'private' && sender && sender.id === message.chat.id) {
          const t = await service.locale(db, sender.id);
          if (!(error instanceof QueryError && error.code === 'outbox_full')) {
            await service.enqueue(db, row.bot_id, sender.id, t(error instanceof QueryError ? error.message : 'Unable to process this request. Please try again from /start.'));
          }
        }
        await db.query('UPDATE telegram_updates SET done = true, payload = NULL, attempts = attempts + 1 WHERE id = $1', [row.id]);
        if (!(error instanceof QueryError)) console.error('Telegram update could not be processed.');
      } else {
        await db.query("UPDATE telegram_updates SET attempts = attempts + 1, available_at = now() + $2 * interval '1 second' WHERE id = $1", [row.id, error instanceof TelegramError ? error.retryAfter : 10]);
      }
    }
    if (row.payload.callback_query) {
      try {
        await service.reserveOutbox(db);
        await db.query("INSERT INTO telegram_outbox (bot_id, method, payload) VALUES ($1, 'answerCallbackQuery', $2)", [row.bot_id, { callback_query_id: row.payload.callback_query.id }]);
      } catch (error) { if (!(error instanceof QueryError && error.code === 'outbox_full')) throw error; }
    }
    await db.query(`INSERT INTO telegram_queue_turns(bot_id,last_served) VALUES ($1,clock_timestamp())
      ON CONFLICT(bot_id) DO UPDATE SET last_served=clock_timestamp()`, [row.bot_id]);
    await db.query('COMMIT');
    return true;
  } catch (error) {
    await db.query('ROLLBACK');
    if (error instanceof QueryError && error.code === 'outbox_full') return false;
    throw error;
  }
}

export async function processOutbox(service: TelegramService, db: PoolClient) {
  const row = (await db.query<{ id: string; bot_id: string; method: string; payload: object; attempts: number }>(
    `SELECT o.* FROM telegram_outbox o WHERE available_at <= now()
      AND NOT EXISTS (SELECT 1 FROM telegram_outbox previous
        WHERE previous.bot_id = o.bot_id AND previous.id < o.id
        AND previous.payload->>'chat_id' = o.payload->>'chat_id')
      ORDER BY o.id LIMIT 1`,
  )).rows[0];
  if (!row) return false;
  try {
    await service.api.call(await service.token(row.bot_id), row.method, row.payload);
    await db.query('DELETE FROM telegram_outbox WHERE id = $1', [row.id]);
  } catch (error) {
    if (row.method === 'editMessageText' && error instanceof TelegramError && error.code === 400) {
      if (error.reason === 'not_modified') {
        await db.query('DELETE FROM telegram_outbox WHERE id=$1', [row.id]);
      } else {
        // Deleted or uneditable panels recover through the same durable delivery queue.
        const { message_id: _messageId, ...payload } = row.payload as Record<string, unknown>;
        await db.query("UPDATE telegram_outbox SET method='sendMessage',payload=$2,attempts=0,available_at=now() WHERE id=$1", [row.id, payload]);
      }
      return true;
    }
    if (row.attempts >= 4 || (error instanceof TelegramError && [400, 401, 403, 404].includes(error.code))) {
      if (error instanceof TelegramError && error.code === 401) {
        await db.query('UPDATE telegram_bots SET enabled = false WHERE id = $1', [row.bot_id]);
      }
      await db.query('DELETE FROM telegram_outbox WHERE id = $1', [row.id]);
      console.error('Telegram message delivery failed.');
    } else {
      await db.query("UPDATE telegram_outbox SET attempts = attempts + 1, available_at = now() + $2 * interval '1 second' WHERE id = $1", [row.id, error instanceof TelegramError ? error.retryAfter : 10]);
    }
  }
  return true;
}

export async function notifyIngestion(service: TelegramService, db: PoolClient) {
  await db.query('BEGIN');
  try {
    const rows = (await db.query(`
      SELECT n.task_id, n.chat_id, t.status, t.knowledge_base_id, kb.name
      FROM telegram_notifications n JOIN ingestion_tasks t ON t.id = n.task_id
      JOIN knowledge_bases kb ON kb.id = t.knowledge_base_id
      WHERE t.status IN ('ready', 'failed') LIMIT 20 FOR UPDATE OF n
    `)).rows;
    for (const row of rows) {
      const t = await service.locale(db, row.chat_id);
      await service.enqueue(db, service.config.managerId, row.chat_id,
        t(row.status === 'ready' ? '{name}: knowledge base is ready.' : '{name}: processing failed. Replace the content to try again.', { name: row.name }),
        { inline_keyboard: [[{ text: t('View knowledge base'), callback_data: `kb:${row.knowledge_base_id}` }]] });
      await db.query('DELETE FROM telegram_notifications WHERE task_id = $1', [row.task_id]);
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    if (error instanceof QueryError && error.code === 'outbox_full') return;
    throw error;
  }
}

export async function notifySecurity(service: TelegramService, db: PoolClient) {
  await db.query('BEGIN');
  try {
    const rows = (await db.query(`SELECT n.*,b.username,b.protection FROM telegram_security_notices n
      JOIN telegram_bots b ON b.id=n.bot_id AND b.owner_id=n.owner_id
      WHERE n.pending>0 AND n.available_at<=now() LIMIT 20 FOR UPDATE OF n`)).rows;
    for (const row of rows) {
      const user = row.owner_id.replace(/^telegram:/, '');
      const t = await service.locale(db, user);
      const settings = protectionSettings(row.protection);
      if (settings.notifications) {
        await service.enqueue(db, service.config.managerId, user,
          t('@{username}: {count} visitor(s) received a repeated-abuse restriction after a warning and an earlier pause. Open restrictions to see expiry times and unblock visitors.', { username: row.username, count: String(row.pending) }),
          { inline_keyboard: [[{ text: t('Restricted visitors'), callback_data: `restricted:${row.bot_id}` }], [{ text: t('Spam protection'), callback_data: `protect:${row.bot_id}` }]] });
      }
      await db.query(`UPDATE telegram_security_notices SET pending=0,last_sent_at=now(),
        available_at=now()+$2*interval '1 minute' WHERE bot_id=$1`, [row.bot_id, Math.max(1, settings.noticeMinutes)]);
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    if (error instanceof QueryError && error.code === 'outbox_full') return;
    throw error;
  }
}

export async function cleanupTelegram(db: PoolClient) {
  await cleanupUploadDrafts(db);
  await db.query(`DELETE FROM telegram_dialogues WHERE (bot_id,user_id,scope) IN
    (SELECT d.bot_id,d.user_id,d.scope FROM telegram_dialogues d WHERE d.expires_at<=now() LIMIT 2000)`);
  await db.query(`UPDATE telegram_sessions SET tuning_result=NULL WHERE user_id IN (SELECT user_id FROM telegram_sessions WHERE tuning_result IS NOT NULL AND updated_at<now()-interval '1 day' LIMIT 2000)`);
  // Bounded batches avoid long cleanup transactions. Telegram retries last at most 24 hours.
  await db.query(`DELETE FROM telegram_updates WHERE id IN (SELECT id FROM telegram_updates
    WHERE done AND available_at<now()-interval '7 days' ORDER BY id LIMIT 2000)`);
  await db.query(`DELETE FROM telegram_visitors WHERE (bot_id,user_id) IN
    (SELECT bot_id,user_id FROM telegram_visitors WHERE updated_at<now()-interval '30 days'
      AND (blocked_until IS NULL OR blocked_until<now()) AND (repeat_until IS NULL OR repeat_until<now()) LIMIT 2000)`);
  await db.query(`DELETE FROM telegram_usage WHERE day<CURRENT_DATE-90`);
  await db.query(`DELETE FROM telegram_owner_rate WHERE window_start<now()-interval '1 day'`);
}

// Register the current public URL for every bot, including paused ones.
export async function refreshWebhooks(service: TelegramService, db: PoolClient) {
  const delivery = await webhookDelivery(service.config.publicUrl);
  await service.api.call(service.config.token, 'setWebhook', {
    url: `${service.config.publicUrl}/telegram/webhook/${service.config.managerId}`,
    secret_token: service.config.webhookSecret, allowed_updates: ['message', 'callback_query', 'managed_bot'],
    ...delivery,
  });
  const bots = await db.query<{ id: string; token_ciphertext: string; webhook_secret: string }>(
    'SELECT id, token_ciphertext, webhook_secret FROM telegram_bots ORDER BY id',
  );
  for (const bot of bots.rows) {
    try {
      await service.api.call(decryptToken(bot.token_ciphertext, service.config.encryptionKey), 'setWebhook', {
        url: `${service.config.publicUrl}/telegram/webhook/${bot.id}`,
        secret_token: bot.webhook_secret, allowed_updates: ['message', 'callback_query'], ...delivery,
      });
    } catch (error) {
      if (!(error instanceof TelegramError) || ![401, 403, 404].includes(error.code)) throw error;
      await db.query('UPDATE telegram_bots SET enabled = false WHERE id = $1', [bot.id]);
      console.error('A managed bot webhook could not be registered. Its credentials may have been revoked; answers are paused.');
    }
  }
}

export async function startTelegramWorker(service: TelegramService, onFailure: () => void) {
  const db = await service.pool.connect();
  const controller = new AbortController();
  let failed = false;
  const onError = () => { failed = true; controller.abort(); };
  db.on('error', onError);
  const progress = new WorkerProgress(db, 'telegram');
  try {
    const result = await db.query('SELECT pg_try_advisory_lock(1792627200, 2) AS locked');
    if (!result.rows[0].locked) throw new Error('Another Telegram worker is running.');
    await progress.record();
    const me = await service.api.call<{ id: number }>(service.config.token, 'getMe');
    if (String(me.id) !== service.config.managerId) throw new Error('Manager identity mismatch.');
    await refreshWebhooks(service, db);
    await service.api.call(service.config.token, 'setMyCommands', { commands: [
      { command: 'start', description: 'Open the main menu' }, { command: 'help', description: 'Show available actions' },
      { command: 'cancel', description: 'Cancel and return to the menu' },
      { command: 'language', description: 'Change interface language' },
      { command: 'openai', description: 'Manage OpenAI key' },
      { command: 'settings', description: 'Account settings' },
    ] });
  } catch (error) {
    db.removeListener('error', onError);
    db.release(true);
    throw error;
  }
  const running = (async () => {
    let cleanedAt = 0;
    try {
      while (!controller.signal.aborted) {
        const worked = await processUpdate(service, db);
        await notifyIngestion(service, db);
        await notifySecurity(service, db);
        if (Date.now() - cleanedAt > 60_000) { await cleanupTelegram(db); cleanedAt = Date.now(); }
        for (let sent = 0; sent < 8; sent++) {
          if (!(await processOutbox(service, db))) break;
          await setTimeout(50, undefined, { signal: controller.signal });
        }
        await progress.record();
        await setTimeout(worked ? 50 : 250, undefined, { signal: controller.signal });
      }
    } catch {
      if (!controller.signal.aborted) failed = true;
    } finally {
      try { await db.query('SELECT pg_advisory_unlock(1792627200, 2)'); } catch { failed = true; }
      db.removeListener('error', onError);
      db.release(failed);
    }
    if (failed) onFailure();
  })();
  return { async stop() { controller.abort(); await running; } };
}
