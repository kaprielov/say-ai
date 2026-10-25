export function up(pgm) {
  pgm.sql(`
    ALTER TABLE telegram_bots
      ADD COLUMN memory_pairs integer NOT NULL DEFAULT 5 CHECK (memory_pairs BETWEEN 0 AND 20),
      ADD COLUMN memory_idle_minutes integer NOT NULL DEFAULT 60 CHECK (memory_idle_minutes BETWEEN 5 AND 10080),
      ADD COLUMN memory_epoch uuid NOT NULL DEFAULT gen_random_uuid();
    CREATE TABLE telegram_dialogues (
      bot_id bigint NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE, user_id bigint NOT NULL,
      scope text NOT NULL CHECK (scope IN ('visitor','test:published','test:draft')),
      signature text NOT NULL, pairs jsonb NOT NULL CHECK (jsonb_typeof(pairs) = 'array' AND jsonb_array_length(pairs) <= 20),
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (bot_id, user_id, scope)
    );
    CREATE INDEX telegram_dialogues_expiry ON telegram_dialogues(expires_at);
  `);
}
export function down(pgm) {
  pgm.sql(`DROP TABLE telegram_dialogues;
    ALTER TABLE telegram_bots DROP COLUMN memory_pairs, DROP COLUMN memory_idle_minutes, DROP COLUMN memory_epoch;`);
}
