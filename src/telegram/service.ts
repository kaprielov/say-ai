import type { OwnerCredentials } from '../providers/owner-openai.js';
import { translator, type Language } from './i18n.js';
import { startTyping } from './typing.js';
import { protectionFields, protectionHelp, protectionSettings, visitorAdmission, ownerAdmission, recordOffTopic, type ProtectionKey } from './protection.js';
import { serverLimits } from '../server-limits.js';
import { webhookDelivery } from './webhook-delivery.js';
import { managerHelp, managerIntroduction, type HelpTopic } from './guide.js';
import { protectionGroups, protectionGroupFor, protectionHints, protectionPresets, helpSummaries, type ProtectionGroup } from './manager-ui.js';
import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createKnowledgeBase, replaceKnowledgeBase } from '../knowledge-bases/service.js';
import { decodeSource, sourceText } from '../ingestion/source.js';
import { QueryError } from '../queries/errors.js';
import type { QuestionAnswering } from '../queries/service.js';
import { decryptToken, encryptToken, type TelegramTransport } from './client.js';

export type TelegramConfig = {
  token: string; managerId: string; webhookSecret: string; publicUrl: string; encryptionKey: Buffer; dailyQueries: number;
};
type User = { id: number; is_bot?: boolean; username?: string };
type Message = {
  chat: { id: number; type: string }; from?: User; text?: string; message_id?: number; key_redacted?: boolean;
  document?: { file_id: string; file_name?: string; file_size?: number };
};
export type Update = {
  update_id: number; message?: Message;
  callback_query?: { id: string; from: User; message?: Message; data?: string };
  managed_bot?: { user: User; bot: User };
};
type Session = { language: Language | null; state: string; knowledge_base_id: string | null; draft_name: string | null };
type Bot = { id: string; owner_id: string; username: string; knowledge_base_id: string | null; token_ciphertext: string; webhook_secret: string; enabled: boolean; protection: Record<string, number> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ownerId = (id: number) => `telegram:${id}`;
const buttons = (rows: [string, string][][]) => ({ inline_keyboard: rows.map(row => row.map(([text, callback_data]) => ({ text, callback_data }))) });

export class TelegramService {
  private readonly panels = new WeakMap<PoolClient, { chat: number; message: number; used: boolean }>();
  constructor(readonly pool: Pool, readonly config: TelegramConfig, readonly api: TelegramTransport, readonly questions?: Pick<QuestionAnswering, 'ask'>, readonly credentials?: OwnerCredentials) {}

  async locale(db: PoolClient, user: number | string) {
    const row = (await db.query<{ language: Language | null }>('SELECT language FROM telegram_sessions WHERE user_id = $1', [user])).rows[0];
    return translator(row?.language ?? 'ru');
  }

  async localeFromPool(user: number) {
    const row = (await this.pool.query('SELECT language FROM telegram_sessions WHERE user_id = $1', [user])).rows[0];
    return translator(row?.language === 'en' ? 'en' : 'ru');
  }

  async chooseLanguage(db: PoolClient, user: number) {
    const current = (await db.query('SELECT language FROM telegram_sessions WHERE user_id=$1', [user])).rows[0]?.language;
    const t = await this.locale(db, user);
    const choices: [string,string][][] = [[['Русский', 'lang:ru'], ['English', 'lang:en']]];
    if (current) choices.push([[t('Back'), 'settings'], [t('Main menu'), 'menu']]);
    await this.enqueue(db, this.config.managerId, user, 'Выберите язык / Choose your language',
      buttons(choices));
  }

  async keySettings(db: PoolClient, user: number) {
    const t = await this.locale(db, user);
    const connected = await this.credentials?.available(ownerId(user));
    const stored = await this.credentials?.stored(ownerId(user));
    await this.enqueue(db, this.config.managerId, user, connected
      ? t('Your OpenAI key is connected. It is used for all your knowledge bases and bots. You can replace or remove it here.')
      : t('Connect your OpenAI API key to continue. Open the secure form below; do not send the key in this chat.'), {
      inline_keyboard: [
        [{ text: t(connected ? 'Replace OpenAI key' : 'Connect OpenAI key'), web_app: { url: `${this.config.publicUrl}/telegram/openai-key?lang=${(await db.query('SELECT language FROM telegram_sessions WHERE user_id = $1', [user])).rows[0]?.language === 'en' ? 'en' : 'ru'}` } }],
        ...(stored ? [[{ text: t('Remove OpenAI key'), callback_data: 'remove_key' }]] : []),
        [{ text: t('Help'), callback_data: 'help:key' }],
        [{ text: t('Back'), callback_data: 'settings' }, { text: t('Main menu'), callback_data: 'menu' }],
      ],
    });
  }

  async token(botId: string) {
    if (botId === this.config.managerId) return this.config.token;
    const result = await this.pool.query<Bot>('SELECT * FROM telegram_bots WHERE id = $1', [botId]);
    if (!result.rows[0]) throw new Error('Bot is unavailable.');
    return decryptToken(result.rows[0].token_ciphertext, this.config.encryptionKey);
  }

  async enqueue(db: PoolClient, botId: string, chat: number | string, text: string, markup?: object) {
    await this.reserveOutbox(db, Math.ceil(text.length / 4000));
    const panel = this.panels.get(db);
    if (panel && !panel.used && botId === this.config.managerId && Number(chat) === panel.chat &&
      text.length <= 4000 && markup && 'inline_keyboard' in markup) {
      panel.used = true;
      await db.query("INSERT INTO telegram_outbox(bot_id,method,payload) VALUES ($1,'editMessageText',$2)", [botId, {
        chat_id: chat, message_id: panel.message, text, reply_markup: markup,
      }]);
      return;
    }
    if (panel && botId === this.config.managerId && Number(chat) === panel.chat) panel.used = true;
    // All production callers hold a transaction until outgoing messages are inserted.
    for (let offset = 0; offset < text.length; offset += 4000) {
      await db.query('INSERT INTO telegram_outbox (bot_id, payload) VALUES ($1, $2)', [botId, {
        chat_id: chat, text: text.slice(offset, offset + 4000), ...(markup && offset === 0 ? { reply_markup: markup } : {}),
      }]);
    }
  }

  async reserveOutbox(db: PoolClient, slots = 1) {
    const locked = (await db.query('SELECT pg_try_advisory_xact_lock(1792972800, 2) AS locked')).rows[0].locked;
    const count = (await db.query('SELECT count(*)::int AS count FROM telegram_outbox')).rows[0].count;
    if (!locked || count + slots > serverLimits.outbox) throw new QueryError(503, 'outbox_full', 'Server capacity is full. Try again later.');
  }

  async session(db: PoolClient, user: number, state: string, kb: string | null = null, name: string | null = null) {
    await db.query(`
      INSERT INTO telegram_sessions (user_id, state, knowledge_base_id, draft_name) VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id) DO UPDATE SET state = $2, knowledge_base_id = $3, draft_name = $4, updated_at = now()
    `, [user, state, kb, name]);
  }

  async base(db: PoolClient, user: number, id: string) {
    const t = await this.locale(db, user);
    if (!uuid.test(id)) throw new QueryError(404, 'not_found', t('Knowledge base not found.'));
    const result = await db.query(`
      SELECT kb.*, latest.status FROM knowledge_bases kb
      LEFT JOIN LATERAL (SELECT status FROM ingestion_tasks WHERE knowledge_base_id = kb.id
        ORDER BY created_at DESC, id DESC LIMIT 1) latest ON true
      WHERE kb.id = $1 AND kb.owner_id = $2
    `, [id, ownerId(user)]);
    if (!result.rows[0]) throw new QueryError(404, 'not_found', t('Knowledge base not found.'));
    return result.rows[0];
  }

  async bot(db: PoolClient, user: number, id: string) {
    const t = await this.locale(db, user);
    if (!/^\d{1,16}$/.test(id)) throw new QueryError(404, 'not_found', t('Bot not found.'));
    const result = await db.query<Bot>('SELECT * FROM telegram_bots WHERE id = $1 AND owner_id = $2', [id, ownerId(user)]);
    if (!result.rows[0]) throw new QueryError(404, 'not_found', t('Bot not found.'));
    return result.rows[0];
  }

  async welcome(db: PoolClient, user: number) {
    const t = await this.locale(db, user);
    await this.enqueue(db, this.config.managerId, user, t(managerIntroduction));
    return this.menu(db, user);
  }

  async menu(db: PoolClient, user: number) {
    const t = await this.locale(db, user);
    await this.session(db, user, 'menu');
    if (this.credentials && !(await this.credentials.available(ownerId(user)))) return this.keySettings(db, user);
    await this.enqueue(db, this.config.managerId, user, t('Manage your knowledge bases and Telegram bots.'), buttons([
      [[t('My bots'), 'bots:0'], [t('My knowledge bases'), 'bases:0']],
      [[t('Create knowledge base'), 'new']], [[t('Settings'), 'settings'], [t('Help'), 'help:menu']],
    ]));
  }

  async settings(db: PoolClient, user: number) {
    const t = await this.locale(db, user);
    await this.session(db, user, 'menu');
    return this.enqueue(db, this.config.managerId, user, t('Account settings'), buttons([
      [[t('OpenAI key'), 'openai']], [[t('Language'), 'language'], [t('Owner limits'), 'limits']], [[t('Back'), 'menu']],
    ]));
  }

  async help(db: PoolClient, user: number, topic: string = 'menu', full = false, context = '') {
    const selected: HelpTopic = Object.hasOwn(managerHelp, topic) ? topic as HelpTopic : 'menu';
    const t = await this.locale(db, user);
    const back = selected === 'base' && uuid.test(context) ? `kb:${context}`
      : selected === 'bot' && /^\d{1,16}$/.test(context) ? `bot:${context}` : selected === 'key' ? 'openai' : 'continue';
    const rows: [string,string][][] = full ? [
      [[t('Back'), `help:${selected}:${context}`], [t('Main menu'), 'menu']],
    ] : [
      [[t('Full guide'), `hf:${selected}:${context}`]],
      [[t('Knowledge base help'), 'help:base'], [t('Telegram bot help'), 'help:bot']],
      [[t('OpenAI key help'), 'help:key']], [[t('Back'), back], [t('Main menu'), 'menu']],
    ];
    await this.enqueue(db, this.config.managerId, user, t(full ? managerHelp[selected] : helpSummaries[selected]), buttons(rows));
  }

  async list(db: PoolClient, user: number, kind: 'bases' | 'bots', page = 0, bindBot?: string) {
    const t = await this.locale(db, user);
    if (bindBot) {
      await this.bot(db, user, bindBot);
      await this.session(db, user, 'bind', null, bindBot);
    } else await this.session(db, user, 'menu');
    const table = kind === 'bases' ? 'knowledge_bases' : 'telegram_bots';
    const total = (await db.query(`SELECT count(*)::int AS count FROM ${table} WHERE owner_id=$1`, [ownerId(user)])).rows[0].count;
    const pages = Math.max(1, Math.ceil(total / 5));
    page = Math.min(pages - 1, Math.max(0, Number.isSafeInteger(page) ? page : 0));
    const rows = kind === 'bases'
      ? (await db.query('SELECT id,name AS label FROM knowledge_bases WHERE owner_id=$1 ORDER BY created_at,id LIMIT 5 OFFSET $2', [ownerId(user), page * 5])).rows
      : (await db.query('SELECT id,username AS label FROM telegram_bots WHERE owner_id=$1 ORDER BY id LIMIT 5 OFFSET $2', [ownerId(user), page * 5])).rows;
    const prefix = kind === 'bases' ? 'kb' : 'bot';
    const items: [string, string][][] = rows.map(row => [[String(row.label).slice(0, 60), bindBot ? `bind:${bindBot}:${row.id}` : `${prefix}:${row.id}:${page}`]]);
    const paging: [string, string][] = [];
    const route = bindBot ? `pick:${bindBot}` : kind;
    if (page > 0) paging.push([t('Previous'), `${route}:${page - 1}`]);
    if (page + 1 < pages) paging.push([t('Next'), `${route}:${page + 1}`]);
    if (paging.length) items.push(paging);
    if (!rows.length) items.push([[t(kind === 'bases' ? 'Create knowledge base' : 'My knowledge bases'), kind === 'bases' ? 'new' : 'bases:0']]);
    items.push([[t('Back'), bindBot ? `bot:${bindBot}` : 'menu'], [t('Main menu'), 'menu']]);
    const title = bindBot ? t('Choose a knowledge base for this bot.') : t(kind === 'bases' ? 'My knowledge bases' : 'My bots');
    const text = rows.length ? `${title} · ${page + 1}/${pages}`
      : t(kind === 'bases' ? 'No knowledge bases yet. Create one and upload your information.' : 'No bots yet. Open a ready knowledge base to create your first bot.');
    await this.enqueue(db, this.config.managerId, user, text, buttons(items));
  }

  async showBase(db: PoolClient, user: number, id: string, page = 0) {
    const t = await this.locale(db, user);
    const kb = await this.base(db, user, id);
    await this.session(db, user, 'selected', id);
    await this.enqueue(db, this.config.managerId, user,
      t('{name}\nStatus: {status}\nAnswers available: {available}', { name: kb.name, status: t(kb.status ?? 'pending'), available: t(kb.active_version_id ? 'yes' : 'no') }),
      buttons([
        ...(['pending', 'processing'].includes(kb.status) ? [[[t('Refresh status'), `kb:${id}`] as [string,string]]] : []),
        ...(kb.active_version_id ? [[[t('Test answers'), `test:${id}`] as [string,string]]] : []),
        ...(!['pending', 'processing'].includes(kb.status) ? [[[t('Replace content'), `replace:${id}`] as [string,string]]] : []),
        ...(kb.active_version_id ? [[[t('Create Telegram bot'), `create:${id}`] as [string,string]]] : []),
        [[t('More actions'), `baseactions:${id}`]],
        [[t('Help'), `help:base:${id}`]], [[t('Back'), `bases:${page}`], [t('Main menu'), 'menu']],
      ]));
  }

  async showBot(db: PoolClient, user: number, id: string, page = 0) {
    const t = await this.locale(db, user);
    const bot = await this.bot(db, user, id);
    await this.session(db, user, 'menu');
    await this.enqueue(db, this.config.managerId, user,
      t('@{username}\nAnswers: {status}\nKnowledge base: {base}\nhttps://t.me/{username}', { username: bot.username, status: t(bot.enabled ? 'enabled' : 'paused'), base: bot.knowledge_base_id ? (await this.base(db, user, bot.knowledge_base_id)).name : t('not selected') }),
      buttons([[[t('Choose knowledge base'), `choose:${id}`]], [[bot.enabled ? t('Pause answers') : t('Publish / enable answers'), `toggle:${id}`]], [[t('Spam protection'), `protect:${id}`]], [[t('Help'), `help:bot:${id}`]], [[t('Back'), `bots:${page}`], [t('Main menu'), 'menu']]]));
  }

  async showProtection(db: PoolClient, user: number, id: string, group?: ProtectionGroup) {
    const bot = await this.bot(db, user, id);
    const t = await this.locale(db, user);
    const settings = protectionSettings(bot.protection);
    await this.session(db, user, 'menu');
    const items: [string, string][][] = group
      ? protectionGroups[group].keys.map(key => [[`${t(protectionFields[key].label)}: ${key === 'notifications' ? t(settings[key] ? 'On' : 'Off') : settings[key]}`, `ps:${id}:${key}`]])
      : Object.entries(protectionGroups).map(([key, value]) => [[t(value.label), `pg:${id}:${key}`]]);
    if (!group) items.push([[t('Restricted visitors'), `restricted:${id}:0`]]);
    items.push([[t('Back'), group ? `protect:${id}` : `bot:${id}`], [t('Main menu'), 'menu']]);
    await this.enqueue(db, this.config.managerId, user,
      `@${bot.username} · ${t('Spam protection')}${group ? ' · ' + t(protectionGroups[group].label) : ''}`, buttons(items));
  }

  async showProtectionField(db: PoolClient, user: number, id: string, key: ProtectionKey, details = false) {
    const bot = await this.bot(db, user, id);
    const t = await this.locale(db, user);
    const field = protectionFields[key];
    const current = protectionSettings(bot.protection)[key];
    await this.session(db, user, 'protection_setting', null, `${bot.id}:${key}`);
    const zeroLabel = key === 'perMinute' ? 'Server limit' : key === 'noticeMinutes' ? '1 minute minimum' : 'Off';
    const choices: [string,string][] = protectionPresets[key].map(value => [
      `${value === current ? '✓ ' : ''}${key === 'notifications' ? t(value ? 'On' : 'Off') : value}`,
      `pv:${id}:${key}:${value}`,
    ]);
    const rows: [string,string][][] = details ? [] : [choices];
    if (!details && key !== 'notifications') rows.push([[t(zeroLabel), `pv:${id}:${key}:0`], [t('Details'), `ph:${id}:${key}`]]);
    if (!details && key === 'notifications') rows.push([[t('Details'), `ph:${id}:${key}`]]);
    rows.push([[t('Back'), details ? `ps:${id}:${key}` : `pg:${id}:${protectionGroupFor(key)}`], [t('Main menu'), 'menu']]);
    await this.enqueue(db, this.config.managerId, user,
      `${t(field.label)}\n\n${t(details ? protectionHelp[key] : protectionHints[key])}\n\n` +
      t('Current value: {current}. Default: {default}.', { current: String(current), default: String(field.value) }) +
      '\n' + t('Choose a value or send a number from 0 to {max}.', { max: String(field.max) }), buttons(rows));
  }

  async showOwnerLimits(db: PoolClient, user: number) {
    const t = await this.locale(db, user);
    const limits = (await db.query('SELECT * FROM telegram_owner_limits WHERE owner_id=$1', [ownerId(user)])).rows[0];
    await this.session(db, user, 'menu');
    await this.enqueue(db, this.config.managerId, user,
      t('Owner limits. Customer questions and tests are counted separately. Zero means no daily quota. Server safety limits always apply.'),
      buttons([[[`${t('Customer questions per day')}: ${limits?.daily ?? this.config.dailyQueries}`, 'ol:daily']],
        [[`${t('Test questions per day')}: ${limits?.testing ?? 0}`, 'ol:testing']], [[t('Back'), 'settings'], [t('Main menu'), 'menu']]]));
  }

  async protectionAction(db: PoolClient, user: number, data: string): Promise<boolean> {
    const t = await this.locale(db, user);
    const [action, id, key] = data.split(':');
    if (action === 'limits') { await this.showOwnerLimits(db, user); return true; }
    if (action === 'ol' && ['daily', 'testing'].includes(id!)) {
      await this.session(db, user, 'owner_limit', null, id);
      await this.enqueue(db, this.config.managerId, user, t('Send a whole number from 0 to {max}. Zero disables this rule. Use /cancel to leave.', { max: '1000000' }), buttons([[[t('Back'), 'limits'], [t('Main menu'), 'menu']]]));
      return true;
    }
    if (!['protect', 'pg', 'ps', 'ph', 'pv', 'restricted', 'unblock'].includes(action!)) return false;
    const bot = await this.bot(db, user, id!);
    if (action === 'protect') await this.showProtection(db, user, bot.id);
    if (action === 'pg') {
      if (!Object.hasOwn(protectionGroups, key!)) throw new QueryError(400, 'invalid_setting', t('Invalid protection setting.'));
      await this.showProtection(db, user, bot.id, key as ProtectionGroup);
    }
    if (action === 'ps' || action === 'ph' || action === 'pv') {
      if (!Object.hasOwn(protectionFields, key!)) throw new QueryError(400, 'invalid_setting', t('Invalid protection setting.'));
      const settingKey = key as ProtectionKey;
      if (action === 'pv') {
        await this.saveProtectionSetting(db, user, { language: null, state: 'protection_setting', knowledge_base_id: null, draft_name: `${bot.id}:${key}` }, data.split(':')[3]);
      } else await this.showProtectionField(db, user, bot.id, settingKey, action === 'ph');
    }
    if (action === 'unblock') {
      if (!/^\d{1,16}$/.test(key!)) throw new QueryError(400, 'invalid_setting', t('Invalid protection setting.'));
      await db.query(`UPDATE telegram_visitors SET blocked_until=NULL,repeat_until=NULL,strikes=0,warning_at=NULL,strike_start=NULL
        WHERE bot_id=$1 AND user_id=$2`, [bot.id, key]);
      await this.enqueue(db, this.config.managerId, user, t('Restriction removed.'));
    }
    if (action === 'restricted' || action === 'unblock') {
      await this.session(db, user, 'menu');
      const total = (await db.query('SELECT count(*)::int AS count FROM telegram_visitors WHERE bot_id=$1 AND blocked_until>now()', [bot.id])).rows[0].count;
      const pages = Math.max(1, Math.ceil(total / 5));
      const requestedPage = action === 'restricted' ? key : data.split(':')[3];
      const page = /^\d{1,5}$/.test(requestedPage ?? '') ? Math.min(pages - 1, Number(requestedPage)) : 0;
      const rows = (await db.query(`SELECT user_id,blocked_until FROM telegram_visitors WHERE bot_id=$1 AND blocked_until>now()
        ORDER BY blocked_until DESC,user_id LIMIT 5 OFFSET $2`, [bot.id, page * 5])).rows;
      const items: [string,string][][] = rows.map(row => [[`${t('Unblock')} ${row.user_id}`, `unblock:${bot.id}:${row.user_id}:${page}`]]);
      const paging: [string,string][] = [];
      if (page > 0) paging.push([t('Previous'), `restricted:${bot.id}:${page - 1}`]);
      if (page + 1 < pages) paging.push([t('Next'), `restricted:${bot.id}:${page + 1}`]);
      if (paging.length) items.push(paging);
      items.push([[t('Back'), `protect:${bot.id}`], [t('Main menu'), 'menu']]);
      await this.enqueue(db, this.config.managerId, user,
        `@${bot.username} · ${t('Restricted visitors')} · ${page + 1}/${pages}\n` +
        (rows.length ? t('Expiry times are UTC. Select a visitor to unblock.') + '\n' + rows.map(row => `${row.user_id}: ${new Date(row.blocked_until).toISOString().slice(0, 16).replace('T', ' ')}`).join('\n') : t('No active restrictions.')),
        buttons(items));
    }
    return true;
  }

  async saveProtectionSetting(db: PoolClient, user: number, session: Session, text?: string) {
    const t = await this.locale(db, user);
    const [id, key] = session.draft_name!.split(':');
    const field = session.state === 'owner_limit' ? { max: 1000000 } : protectionFields[key as ProtectionKey];
    if (!text || !/^\d{1,7}$/.test(text.trim()) || Number(text) > field.max) {
      throw new QueryError(400, 'invalid_setting', t('Send a whole number from 0 to {max}.', { max: String(field.max) }));
    }
    if (session.state === 'owner_limit') {
      await db.query(`INSERT INTO telegram_owner_limits(owner_id,daily) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ownerId(user), this.config.dailyQueries]);
      const column = id === 'testing' ? 'testing' : 'daily';
      await db.query(`UPDATE telegram_owner_limits SET ${column}=$2 WHERE owner_id=$1`, [ownerId(user), Number(text)]);
      return this.showOwnerLimits(db, user);
    }
    await this.bot(db, user, id!);
    await db.query(`UPDATE telegram_bots SET protection=jsonb_set(protection,ARRAY[$3::text],to_jsonb($4::int)) WHERE id=$1 AND owner_id=$2`, [id, ownerId(user), key, Number(text)]);
    return this.showProtection(db, user, id!, protectionGroupFor(key as ProtectionKey));
  }

  async handle(db: PoolClient, botId: string, update: Update) {
    const message = update.callback_query?.message;
    if (botId === this.config.managerId && message?.chat.type === 'private' &&
      Number.isSafeInteger(message.message_id) && message.message_id! > 0) {
      this.panels.set(db, { chat: message.chat.id, message: message.message_id!, used: false });
    }
    try { await this.handleUpdate(db, botId, update); }
    finally { this.panels.delete(db); }
  }

  private async handleUpdate(db: PoolClient, botId: string, update: Update) {
    if (botId === this.config.managerId && update.managed_bot) {
      await this.managed(db, update.managed_bot);
      return;
    }
    const callback = update.callback_query;
    const message = callback?.message ?? update.message;
    const user = callback?.from ?? message?.from;
    // Management and answering are private-chat-only in this release.
    if (!message || !user || user.is_bot || message.chat.type !== 'private' || message.chat.id !== user.id) return;
    const t = await this.locale(db, user.id);
    if (botId !== this.config.managerId) {
      const bot = (await db.query<Bot>('SELECT * FROM telegram_bots WHERE id = $1', [botId])).rows[0];
      if (!bot?.enabled || !bot.knowledge_base_id) {
        await this.enqueue(db, botId, user.id, t('This bot is currently paused.'));
      } else if (message.text?.startsWith('/start')) {
        await this.enqueue(db, botId, user.id, t('Ask me a question about the knowledge base.'));
      } else if (message.text) {
        await this.answer(db, botId, user.id, bot.owner_id, bot.knowledge_base_id, message.text);
      }
      return;
    }
    if (message.key_redacted && message.message_id) {
      await this.reserveOutbox(db);
      await db.query("INSERT INTO telegram_outbox (bot_id, method, payload) VALUES ($1, 'deleteMessage', $2)", [botId, { chat_id: user.id, message_id: message.message_id }]);
    }
    const text = message.text;
    const command = text?.split(' ')[0];
    if (callback?.data === 'language' || command === '/language') return this.chooseLanguage(db, user.id);
    if (callback?.data?.startsWith('lang:')) {
      const language = callback.data.slice(5);
      if (language !== 'en' && language !== 'ru') return this.chooseLanguage(db, user.id);
      await db.query(`INSERT INTO telegram_sessions (user_id, language) VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET language = $2, updated_at = now()`, [user.id, language]);
      const selected = translator(language);
      await this.enqueue(db, botId, user.id, selected('Language saved.'), { remove_keyboard: true });
      await this.reserveOutbox(db);
      await db.query("INSERT INTO telegram_outbox (bot_id, method, payload) VALUES ($1, 'setMyCommands', $2)", [botId, {
        scope: { type: 'chat', chat_id: user.id },
        commands: [
          { command: 'start', description: selected('Open the main menu') },
          { command: 'help', description: selected('Show available actions') },
          { command: 'cancel', description: selected('Cancel and return to the menu') },
          { command: 'language', description: selected('Change interface language') },
          { command: 'openai', description: selected('Manage OpenAI key') },
          { command: 'settings', description: selected('Account settings') },
        ],
      }]);
      return this.welcome(db, user.id);
    }
    const session = (await db.query<Session>('SELECT * FROM telegram_sessions WHERE user_id = $1', [user.id])).rows[0];
    if (!session?.language) return this.chooseLanguage(db, user.id);
    if (command === '/help' || callback?.data === 'help' || callback?.data?.startsWith('help:') || callback?.data?.startsWith('hf:')) {
      return this.help(db, user.id, callback?.data?.split(':')[1], callback?.data?.startsWith('hf:'), callback?.data?.split(':')[2]);
    }
    if (command === '/start') return this.welcome(db, user.id);
    if (command === '/settings') return this.settings(db, user.id);
    if ((command && ['/menu', '/cancel'].includes(command)) || callback?.data === 'menu') return this.menu(db, user.id);
    if (this.credentials) {
      if (command === '/openai' || callback?.data === 'openai') return this.keySettings(db, user.id);
      if (callback?.data === 'remove_key') {
        return this.enqueue(db, botId, user.id, t('Remove your OpenAI key? Your bots will stop answering until you connect another key.'),
          buttons([[[t('Remove key'), 'confirm_remove_key']], [[t('Cancel'), 'openai']]]));
      }
      if (callback?.data === 'confirm_remove_key') {
        await this.credentials.remove(ownerId(user.id));
        return this.keySettings(db, user.id);
      }
      if (!(await this.credentials.available(ownerId(user.id)))) return this.keySettings(db, user.id);
    }
    if (callback?.data) {
      if (await this.protectionAction(db, user.id, callback.data)) return;
      return this.action(db, user.id, callback.data);
    }
    if (session.state === 'protection_setting' || session.state === 'owner_limit') return this.saveProtectionSetting(db, user.id, session, text);
    if (session.state === 'name' || session.state === 'rename') {
      if (!text?.trim() || text.trim().length > 80 || text.includes('\0')) throw new QueryError(400, 'invalid_name', t('Send a name between 1 and 80 characters.'));
      if (session.state === 'rename') {
        await this.base(db, user.id, session.knowledge_base_id!);
        await db.query('UPDATE knowledge_bases SET name = $1 WHERE id = $2 AND owner_id = $3', [text.trim(), session.knowledge_base_id, ownerId(user.id)]);
        return this.showBase(db, user.id, session.knowledge_base_id!);
      }
      await this.session(db, user.id, 'upload', null, text.trim());
      await this.enqueue(db, botId, user.id, t('Send text or a file up to 1 MiB. Scanned pages need text recognition first.'),
        buttons([[[t('Supported files'), 'hf:base']], [[t('Back'), 'new'], [t('Main menu'), 'menu']]]));
      return;
    }
    if (session.state === 'upload' || session.state === 'replace') {
      let content = text;
      if (message.document) {
        const file = message.document;
        if ((file.file_size ?? 0) > 1024 * 1024) throw new QueryError(413, 'payload_too_large', t('File must not exceed 1 MiB.'));
        content = await decodeSource(await this.api.download(this.config.token, file.file_id), file.file_name ?? '');
      }
      const source = sourceText({ text: content });
      if (Buffer.byteLength(source) > 1024 * 1024) throw new QueryError(413, 'payload_too_large', t('Text must not exceed 1 MiB.'));
      if (session.state === 'upload') {
        const count = await db.query('SELECT count(*)::int AS count FROM knowledge_bases WHERE owner_id = $1', [ownerId(user.id)]);
        if (count.rows[0].count >= 20) throw new QueryError(429, 'base_limit', t('You can create up to 20 knowledge bases.'));
      }
      const result = session.state === 'replace'
        ? await replaceKnowledgeBase(db, ownerId(user.id), session.knowledge_base_id!, source)
        : await createKnowledgeBase(db, ownerId(user.id), source, session.draft_name!);
      await db.query('INSERT INTO telegram_notifications (task_id, chat_id) VALUES ($1, $2)', [result.taskId, user.id]);
      await this.session(db, user.id, 'selected', result.id);
      await this.enqueue(db, botId, user.id, t('Content accepted. Processing will continue in the background; you will receive a notification.'), buttons([[[t('View knowledge base'), `kb:${result.id}`]]]));
      return;
    }
    if (session.state === 'create_bot' && session.knowledge_base_id) {
      const kb = await this.base(db, user.id, session.knowledge_base_id);
      return this.promptBotCreation(db, user.id, kb.name);
    }
    if (session.state === 'test' && text && session.knowledge_base_id) {
      await this.base(db, user.id, session.knowledge_base_id);
      return this.answer(db, botId, user.id, ownerId(user.id), session.knowledge_base_id, text);
    }
    await this.enqueue(db, botId, user.id, t('Use the menu buttons, or /cancel to return to the main menu.'));
  }

  async promptBotCreation(db: PoolClient, user: number, name: string) {
    const t = await this.locale(db, user);
    return this.enqueue(db, this.config.managerId, user,
      t('Tap Create Telegram bot below the message field. Choose a name and username in Telegram; the bot will then be ready to answer.'), {
        keyboard: [[{ text: t('Create Telegram bot'), request_managed_bot: { request_id: 1, suggested_name: name.slice(0, 64) } }]],
        resize_keyboard: true, one_time_keyboard: true, input_field_placeholder: t('Tap Create Telegram bot below'),
      });
  }

  async action(db: PoolClient, user: number, data: string): Promise<unknown> {
    const t = await this.locale(db, user);
    const [action, id = '', extra = ''] = data.split(':');
    if (action === 'menu') return this.menu(db, user);
    if (action === 'settings') return this.settings(db, user);
    if (action === 'continue') {
      const session = (await db.query<Session>('SELECT * FROM telegram_sessions WHERE user_id=$1', [user])).rows[0];
      if (session?.state === 'protection_setting' && session.draft_name) {
        const [bot, key] = session.draft_name.split(':');
        if (Object.hasOwn(protectionFields, key!)) return this.showProtectionField(db, user, bot!, key as ProtectionKey);
      }
      if (session?.state === 'owner_limit') return this.protectionAction(db, user, `ol:${session.draft_name}`);
      if (session?.state === 'bind' && session.draft_name) return this.list(db, user, 'bases', 0, session.draft_name);
      if (session?.state === 'upload') return this.enqueue(db, this.config.managerId, user,
        t('Send text or a file up to 1 MiB. Scanned pages need text recognition first.'), buttons([[[t('Back'), 'new'], [t('Main menu'), 'menu']]]));
      if (session?.state === 'name') return this.action(db, user, 'new');
      if (session?.knowledge_base_id) {
        if (['replace', 'rename', 'test', 'create_bot'].includes(session.state)) return this.action(db, user, `${session.state === 'create_bot' ? 'create' : session.state}:${session.knowledge_base_id}`);
        return this.showBase(db, user, session.knowledge_base_id);
      }
      return this.menu(db, user);
    }
    if (action === 'new') {
      await this.session(db, user, 'name');
      return this.enqueue(db, this.config.managerId, user, t('What is the name of your knowledge base?'), buttons([[[t('Back'), 'menu']]]));
    }
    if (action === 'bases' || action === 'bots') {
      return this.list(db, user, action, /^\d{1,5}$/.test(id) ? Number(id) : 0);
    }
    if (action === 'pick') return this.list(db, user, 'bases', /^\d{1,5}$/.test(extra) ? Number(extra) : 0, id);
    if (action === 'bot') return this.showBot(db, user, id, /^\d{1,5}$/.test(extra) ? Number(extra) : 0);
    if (action === 'choose') {
      await this.bot(db, user, id);
      await this.session(db, user, 'bind', null, id);
      return this.list(db, user, 'bases', 0, id);
    }
    if (action === 'bind') {
      const baseId = extra || id;
      await this.base(db, user, baseId);
      const session = (await db.query<Session>('SELECT * FROM telegram_sessions WHERE user_id = $1', [user])).rows[0];
      if (!extra && session?.state !== 'bind') throw new QueryError(409, 'expired_action', t('Choose the bot again from My bots.'));
      const bot = await this.bot(db, user, extra ? id : session.draft_name!);
      await db.query('UPDATE telegram_bots SET knowledge_base_id = $1, enabled = false WHERE id = $2', [baseId, bot.id]);
      await this.session(db, user, 'menu');
      return this.showBot(db, user, bot.id);
    }
    if (action === 'toggle') {
      const bot = await this.bot(db, user, id);
      if (!bot.enabled && !bot.knowledge_base_id) throw new QueryError(409, 'missing_base', t('Choose a knowledge base first.'));
      if (!bot.enabled) {
        const kb = await this.base(db, user, bot.knowledge_base_id!);
        if (!kb.active_version_id) throw new QueryError(409, 'not_ready', t('Wait until the knowledge base is ready.'));
        await this.api.call(decryptToken(bot.token_ciphertext, this.config.encryptionKey), 'getMe');
        await this.api.call(this.config.token, 'setManagedBotAccessSettings', { user_id: Number(id), is_access_restricted: false });
      }
      await db.query('UPDATE telegram_bots SET enabled = NOT enabled WHERE id = $1', [id]);
      return this.showBot(db, user, id);
    }
    const kb = await this.base(db, user, id);
    if (action === 'kb') return this.showBase(db, user, id, /^\d{1,5}$/.test(extra) ? Number(extra) : 0);
    if (action === 'baseactions') return this.enqueue(db, this.config.managerId, user, kb.name, buttons([
      [[t('Refresh status'), `kb:${id}`], [t('Rename'), `rename:${id}`]],
      [[t('Delete knowledge base'), `delete:${id}`]], [[t('Back'), `kb:${id}`], [t('Main menu'), 'menu']],
    ]));
    if (action === 'replace' || action === 'rename' || action === 'test') {
      await this.session(db, user, action, id);
      return this.enqueue(db, this.config.managerId, user, action === 'replace' ? t('Send a file or text to replace the complete content. The previous ready version stays available during processing.') : action === 'rename' ? t('Send the new name.') : t('Send a question to test this knowledge base. Use /cancel when finished.'),
        buttons([[[t(action === 'test' ? 'Finish testing' : 'Back'), `kb:${id}`], [t('Main menu'), 'menu']]]));
    }
    if (action === 'create') {
      if (!kb.active_version_id) throw new QueryError(409, 'not_ready', t('Wait until the knowledge base is ready.'));
      await this.session(db, user, 'create_bot', id);
      return this.promptBotCreation(db, user, kb.name);
    }
    if (action === 'delete') return this.enqueue(db, this.config.managerId, user, t('Delete {name} and its content permanently? Connected bots will be paused.', { name: kb.name }), buttons([[[t('Delete permanently'), `confirmdelete:${id}`]], [[t('Cancel'), `kb:${id}`]]]));
    if (action === 'confirmdelete') {
      await db.query('SELECT id FROM knowledge_bases WHERE id = $1 AND owner_id = $2 FOR UPDATE', [id, ownerId(user)]);
      const busy = await db.query("SELECT id FROM ingestion_tasks WHERE knowledge_base_id = $1 AND status IN ('pending', 'processing')", [id]);
      if (busy.rows.length) throw new QueryError(409, 'ingestion_in_progress', t('Wait for content processing to finish before deleting this knowledge base.'));
      await db.query('UPDATE telegram_bots SET knowledge_base_id = NULL, enabled = false WHERE knowledge_base_id = $1', [id]);
      await db.query('DELETE FROM telegram_notifications WHERE task_id IN (SELECT id FROM ingestion_tasks WHERE knowledge_base_id = $1)', [id]);
      await db.query('UPDATE knowledge_bases SET active_version_id = NULL WHERE id = $1', [id]);
      await db.query('DELETE FROM content_versions WHERE knowledge_base_id = $1', [id]);
      await db.query('DELETE FROM ingestion_tasks WHERE knowledge_base_id = $1', [id]);
      await db.query('DELETE FROM knowledge_bases WHERE id = $1 AND owner_id = $2', [id, ownerId(user)]);
      await db.query("UPDATE telegram_sessions SET state = 'menu', knowledge_base_id = NULL WHERE knowledge_base_id = $1", [id]);
      return this.menu(db, user);
    }
  }

  async answer(db: PoolClient, botId: string, chat: number, owner: string, kb: string, question: string) {
    const testing = botId === this.config.managerId;
    const t = await this.locale(db, chat);
    if (!question.trim() || question.includes('\0') || question.length > 4096) throw new QueryError(400, 'invalid_question', t('Send a question between 1 and 4096 characters.'));
    if (!this.questions) throw new QueryError(503, 'querying_unavailable', t('Question answering is not configured.'));
    const bot = testing ? undefined : (await db.query<Bot>('SELECT * FROM telegram_bots WHERE id=$1', [botId])).rows[0];
    const settings = protectionSettings(bot?.protection);
    if (!testing) {
      const admission = await visitorAdmission(db, botId, chat, question, settings);
      if (!admission.allowed) {
        if (admission.message) await this.enqueue(db, botId, chat, t(admission.message));
        return;
      }
    }
    if (!(await ownerAdmission(db, owner))) {
      // Silently shed excess work; replying to every rejected request amplifies floods.
      return;
    }
    const limits = (await db.query('SELECT * FROM telegram_owner_limits WHERE owner_id=$1', [owner])).rows[0];
    const dailyLimit = testing ? limits?.testing ?? 0 : limits?.daily ?? this.config.dailyQueries;
    const column = testing ? 'test_queries' : 'queries';
    const quota = await db.query(`
      INSERT INTO telegram_usage (owner_id, ${column}) VALUES ($1, 1)
      ON CONFLICT (owner_id, day) DO UPDATE SET ${column} = telegram_usage.${column} + 1
      WHERE $2::int = 0 OR telegram_usage.${column} < $2 RETURNING ${column}
    `, [owner, dailyLimit]);
    if (!quota.rows[0]) throw new QueryError(429, 'daily_limit', t('The daily question limit for this owner has been reached.'));
    const stopTyping = startTyping(this.api, this.token(botId), chat);
    try {
      const result = await this.questions.ask(kb, owner, question, AbortSignal.timeout(30_000));
      await this.enqueue(db, botId, chat, result.outcome === 'answered' || result.outcome === 'redirected' ? result.answer! : t('I do not have that information. What would you like to know about the subject of this bot?'));
      if (!testing && result.outcome === 'redirected' && 'topic' in result && result.topic === 'off_topic') {
        const action = await recordOffTopic(db, botId, chat, owner, settings);
        if (action) await this.enqueue(db, botId, chat, t(action.message, { minutes: String(action.minutes) }));
      }
    } catch (error) {
      // Keep the quota reservation even when a paid provider request fails.
      await this.enqueue(db, botId, chat, error instanceof QueryError && error.status < 500 ? t(error.message) : t('I could not answer just now. Please try your question again shortly.'));
    } finally {
      stopTyping();
    }
  }

  async managed(db: PoolClient, event: NonNullable<Update['managed_bot']>) {
    const t = await this.locale(db, event.user.id);
    if (!Number.isSafeInteger(event.user.id) || !Number.isSafeInteger(event.bot.id) || !event.bot.username || !event.bot.is_bot) return;
    const id = String(event.bot.id);
    if (id === this.config.managerId) return;
    const owner = ownerId(event.user.id);
    const existing = (await db.query<Bot>('SELECT * FROM telegram_bots WHERE id = $1 FOR UPDATE', [id])).rows[0];
    const sameOwner = existing?.owner_id === owner;
    const session = (await db.query<Session>('SELECT * FROM telegram_sessions WHERE user_id = $1', [event.user.id])).rows[0];
    let kb = sameOwner ? existing.knowledge_base_id : null;
    let enabled = sameOwner ? existing.enabled : false;
    if (!existing && session?.state === 'create_bot' && session.knowledge_base_id) {
      const selected = (await db.query('SELECT id, active_version_id FROM knowledge_bases WHERE id = $1 AND owner_id = $2', [session.knowledge_base_id, owner])).rows[0];
      kb = selected?.id ?? null;
      enabled = Boolean(selected?.active_version_id);
    }
    const token = await this.api.call<string>(this.config.token, 'getManagedBotToken', { user_id: event.bot.id });
    const me = await this.api.call<User>(token, 'getMe');
    if (me.id !== event.bot.id) throw new Error('Managed bot identity mismatch.');
    const secret = existing?.webhook_secret ?? randomBytes(32).toString('base64url');
    await this.api.call(token, 'setWebhook', { url: `${this.config.publicUrl}/telegram/webhook/${id}`, secret_token: secret, allowed_updates: ['message'], ...await webhookDelivery(this.config.publicUrl) });
    if (!sameOwner) {
      await this.api.call(this.config.token, 'setManagedBotAccessSettings', { user_id: event.bot.id, is_access_restricted: !enabled });
      // Do not deliver queued answers from a previous owner's knowledge base.
      await db.query('DELETE FROM telegram_outbox WHERE bot_id = $1', [id]);
      if (existing) {
        await db.query('DELETE FROM telegram_visitors WHERE bot_id=$1', [id]);
        await db.query('DELETE FROM telegram_security_notices WHERE bot_id=$1', [id]);
        await db.query("UPDATE telegram_bots SET protection='{}' WHERE id=$1", [id]);
      }
    }
    await db.query(`
      INSERT INTO telegram_bots (id, owner_id, username, knowledge_base_id, token_ciphertext, webhook_secret, enabled)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET owner_id = $2, username = $3, knowledge_base_id = $4, token_ciphertext = $5, enabled = $7
    `, [id, owner, event.bot.username, kb, encryptToken(token, this.config.encryptionKey), secret, enabled]);
    if (session?.state === 'create_bot') await this.session(db, event.user.id, 'menu');
    await this.enqueue(db, this.config.managerId, event.user.id, enabled ? t('Your bot is ready to answer questions. Open the link below to try it.') : t('Bot connected. Choose a ready knowledge base and enable answers from My bots.'), { remove_keyboard: true });
    await this.showBot(db, event.user.id, id);
  }
}
