import type { PoolClient } from 'pg';
import type { DialoguePair } from '../queries/answerer.js';
import { countTokens } from '../ingestion/chunking.js';

export type MemorySettings = { memory_pairs: number; memory_idle_minutes: number; memory_epoch: string };

// Keep complete pairs within a second, independent token bound, newest first in priority.
export function boundHistory(pairs: DialoguePair[], limit: number): DialoguePair[] {
  if (limit <= 0) return [];
  const result: DialoguePair[] = [];
  for (const pair of pairs.slice(-Math.min(20, Math.max(0, limit))).reverse()) {
    if (countTokens(JSON.stringify([pair, ...result])) > 6000) break;
    result.unshift(pair);
  }
  return result;
}

export async function loadDialogue(db: PoolClient, bot: string, user: number, scope: string, signature: string, settings: MemorySettings) {
  if (!settings.memory_pairs) return [];
  const row = (await db.query<{ pairs: DialoguePair[] }>(`SELECT pairs FROM telegram_dialogues
    WHERE bot_id=$1 AND user_id=$2 AND scope=$3 AND signature=$4 AND expires_at>now()`,
  [bot, user, scope, signature])).rows[0];
  return boundHistory(row?.pairs ?? [], settings.memory_pairs);
}

export async function saveDialogue(db: PoolClient, bot: string, user: number, scope: string, signature: string,
  settings: MemorySettings, pairs: DialoguePair[]) {
  if (!settings.memory_pairs) return;
  await db.query(`INSERT INTO telegram_dialogues(bot_id,user_id,scope,signature,pairs,expires_at)
    VALUES ($1,$2,$3,$4,$5,now()+$6*interval '1 minute')
    ON CONFLICT(bot_id,user_id,scope) DO UPDATE SET signature=EXCLUDED.signature,pairs=EXCLUDED.pairs,expires_at=EXCLUDED.expires_at`,
  [bot, user, scope, signature, JSON.stringify(boundHistory(pairs, settings.memory_pairs)), settings.memory_idle_minutes]);
}
