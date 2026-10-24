import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { QueryError } from '../queries/errors.js';

export type BotAnswerSettings = { instructions: string; detail: 'standard' | 'concise' | 'detailed'; language: 'auto' | 'ru' | 'en'; retrieval: 'balanced' | 'focused' | 'expanded' };
export const defaultBotSettings: BotAnswerSettings = { instructions: '', detail: 'standard', language: 'auto', retrieval: 'balanced' };
export type SettingsRevision = { id: string; settings: BotAnswerSettings };
export type SettingsState = { version: string; draft: BotAnswerSettings | null; published: SettingsRevision; history: SettingsRevision[] };
type Database = Pool | PoolClient;

export function validateBotSettings(value: unknown): BotAnswerSettings {
  const s = value as BotAnswerSettings | null;
  if (!s || typeof s.instructions !== 'string' || s.instructions.length > 4000 || s.instructions.includes('\0') ||
    !['standard', 'concise', 'detailed'].includes(s.detail) || !['auto', 'ru', 'en'].includes(s.language) ||
    !['balanced', 'focused', 'expanded'].includes(s.retrieval)) {
    throw new QueryError(400, 'invalid_bot_settings', 'Use valid profiles and instructions up to 4000 characters without null characters.');
  }
  return { instructions: s.instructions.trim(), detail: s.detail, language: s.language, retrieval: s.retrieval };
}

export class BotSettings {
  async read(db: Database, id: string, owner: string): Promise<SettingsState> {
    if (!/^\d{1,16}$/.test(id)) throw new QueryError(404, 'not_found', 'Bot not found.');
    const row = (await db.query<{ answer_settings: SettingsState }>('SELECT answer_settings FROM telegram_bots WHERE id=$1 AND owner_id=$2', [id, owner])).rows[0];
    if (!row) throw new QueryError(404, 'not_found', 'Bot not found.');
    return row.answer_settings;
  }

  private async change(db: Database, id: string, owner: string, version: string, update: (state: SettingsState) => void) {
    const state = await this.read(db, id, owner);
    if (state.version !== version) throw new QueryError(409, 'stale_settings', 'Settings changed. Reopen Answer settings and try again.');
    update(state);
    state.version = randomUUID();
    const result = await db.query('UPDATE telegram_bots SET answer_settings=$3 WHERE id=$1 AND owner_id=$2 AND answer_settings->>\'version\'=$4 RETURNING id', [id, owner, state, version]);
    if (!result.rowCount) throw new QueryError(409, 'stale_settings', 'Settings changed. Reopen Answer settings and try again.');
    return state;
  }

  save(db: Database, id: string, owner: string, version: string, settings: BotAnswerSettings) {
    const validated = validateBotSettings(settings);
    return this.change(db, id, owner, version, state => { state.draft = validated; });
  }

  discard(db: Database, id: string, owner: string, version: string) {
    return this.change(db, id, owner, version, state => { state.draft = null; });
  }

  publish(db: Database, id: string, owner: string, version: string) {
    return this.change(db, id, owner, version, state => {
      if (!state.draft) throw new QueryError(409, 'no_draft', 'There is no draft to publish.');
      state.history = [...state.history, state.published].slice(-20);
      state.published = { id: randomUUID(), settings: validateBotSettings(state.draft) };
      state.draft = null;
    });
  }

  rollback(db: Database, id: string, owner: string, version: string) {
    return this.change(db, id, owner, version, state => {
      const previous = state.history.at(-1);
      if (!previous) throw new QueryError(409, 'no_previous_settings', 'There is no previous published version.');
      state.history = [...state.history.slice(0, -1), state.published];
      state.published = previous;
      // Keep unfinished edits so rollback never silently destroys a draft.
    });
  }
}
