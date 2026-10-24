import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { serverLimits } from '../server-limits.js';

export const protectionFields = {
  perMinute: { label: 'Questions per minute', value: 5, max: 30 },
  perDay: { label: 'Questions per day', value: 30, max: 1000000 },
  duplicateSeconds: { label: 'Duplicate window (seconds)', value: 60, max: 3600 },
  strikes: { label: 'Off-topic requests before warning', value: 3, max: 100 },
  windowMinutes: { label: 'Off-topic window (minutes)', value: 10, max: 1440 },
  pauseMinutes: { label: 'First pause (minutes)', value: 15, max: 10080 },
  repeatHours: { label: 'Repeated abuse pause (hours)', value: 6, max: 720 },
  repeatWindowHours: { label: 'Repeat detection window (hours)', value: 24, max: 720 },
  notifications: { label: 'Owner notifications (0 or 1)', value: 1, max: 1 },
  noticeMinutes: { label: 'Notification interval (minutes)', value: 15, max: 1440 },
} as const;
export type ProtectionKey = keyof typeof protectionFields;
export type Protection = Record<ProtectionKey, number>;
export function protectionSettings(stored: Partial<Protection> = {}): Protection {
  return Object.fromEntries(Object.entries(protectionFields).map(([key, field]) => {
    const value = stored[key as ProtectionKey];
    return [key, Number.isSafeInteger(value) && value! >= 0 && value! <= field.max ? value : field.value];
  })) as Protection;
}

export async function visitorAdmission(db: PoolClient, bot: string, user: number, question: string, settings: Protection) {
  await db.query(`INSERT INTO telegram_visitors(bot_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [bot, user]);
  const state = (await db.query(`SELECT *, blocked_until > now() AS blocked,
    minute_start > now() - interval '1 minute' AS same_minute,
    day = CURRENT_DATE AS same_day,
    last_question_at > now() - $3 * interval '1 second' AS duplicate_window
    FROM telegram_visitors WHERE bot_id=$1 AND user_id=$2 FOR UPDATE`, [bot, user, settings.duplicateSeconds])).rows[0];
  if (state.blocked) return { allowed: false, message: null };
  const hash = createHash('sha256').update(question.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex');
  if (settings.duplicateSeconds && state.last_hash === hash && state.duplicate_window) return { allowed: false, message: null };
  const minute = state.same_minute ? state.minute_count : 0;
  const day = state.same_day ? state.day_count : 0;
  const minuteLimit = settings.perMinute || serverLimits.visitorPerMinute;
  const denied = minute >= minuteLimit || (settings.perDay > 0 && day >= settings.perDay);
  // Rejections do not create one outgoing reply per incoming spam message.
  const shouldNotify = denied && (!state.notice_at || Date.now() - new Date(state.notice_at).getTime() > 60_000);
  await db.query(`UPDATE telegram_visitors SET
    minute_start=CASE WHEN $3 THEN minute_start ELSE now() END,
    minute_count=$4, day=CURRENT_DATE, day_count=$5,
    last_hash=CASE WHEN $6 THEN last_hash ELSE $7 END,
    last_question_at=CASE WHEN $6 THEN last_question_at ELSE now() END,
    notice_at=CASE WHEN $8 THEN now() ELSE notice_at END, updated_at=now()
    WHERE bot_id=$1 AND user_id=$2`, [bot, user, state.same_minute, Math.min(minute + 1, 1000000), day + (denied ? 0 : 1), denied, hash, shouldNotify]);
  return { allowed: !denied, message: shouldNotify ? 'Your question limit has been reached. Please try again later.' : null };
}

export async function ownerAdmission(db: PoolClient, owner: string) {
  const result = await db.query(`INSERT INTO telegram_owner_rate(owner_id,requests) VALUES ($1,1)
    ON CONFLICT(owner_id) DO UPDATE SET
      requests=CASE WHEN telegram_owner_rate.window_start <= now()-interval '1 minute' THEN 1 ELSE telegram_owner_rate.requests+1 END,
      window_start=CASE WHEN telegram_owner_rate.window_start <= now()-interval '1 minute' THEN now() ELSE telegram_owner_rate.window_start END
    WHERE telegram_owner_rate.window_start <= now()-interval '1 minute' OR telegram_owner_rate.requests < $2
    RETURNING owner_id`, [owner, serverLimits.ownerPerMinute]);
  return Boolean(result.rows.length);
}

export async function recordOffTopic(db: PoolClient, bot: string, user: number, owner: string, settings: Protection) {
  if (!settings.strikes || !settings.windowMinutes) return null;
  const row = (await db.query(`SELECT *, strike_start > now()-$3*interval '1 minute' AS in_window,
    repeat_until > now() AS repeated FROM telegram_visitors WHERE bot_id=$1 AND user_id=$2 FOR UPDATE`, [bot, user, settings.windowMinutes])).rows[0];
  const strikes = row.in_window ? row.strikes + 1 : 1;
  const warned = row.in_window && row.warning_at;
  const minutes = row.repeated ? settings.repeatHours * 60 : settings.pauseMinutes;
  const block = Boolean(warned && strikes > settings.strikes && minutes > 0);
  await db.query(`UPDATE telegram_visitors SET
    strike_start=CASE WHEN $4 THEN strike_start ELSE now() END,
    warning_at=CASE WHEN $5 THEN now() WHEN $4 THEN warning_at ELSE NULL END,
    blocked_until=CASE WHEN $6 THEN now()+$7*interval '1 minute' ELSE blocked_until END,
    repeat_until=CASE WHEN $6 THEN now()+($7+$8*60)*interval '1 minute' ELSE repeat_until END,
    strikes=CASE WHEN $6 THEN 0 ELSE $3 END,
    updated_at=now() WHERE bot_id=$1 AND user_id=$2`,
  [bot, user, strikes, row.in_window, strikes === settings.strikes, block, minutes, settings.repeatWindowHours]);
  if (block && row.repeated && settings.notifications) {
    await db.query(`INSERT INTO telegram_security_notices(bot_id,owner_id,pending) VALUES ($1,$2,1)
      ON CONFLICT(bot_id) DO UPDATE SET pending=telegram_security_notices.pending+1, owner_id=$2`, [bot, owner]);
  }
  if (block) return { message: 'Answers are paused for {minutes} minutes because off-topic requests continued after a warning.', minutes };
  if (strikes === settings.strikes) return { message: 'Please keep questions on the subject of this bot. Further off-topic requests will temporarily pause answers.', minutes: 0 };
  return null;
}
