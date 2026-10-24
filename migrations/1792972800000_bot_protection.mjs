export function up(pgm) {
  pgm.sql(`
    ALTER TABLE telegram_bots ADD COLUMN protection jsonb NOT NULL DEFAULT '{}';
    ALTER TABLE telegram_usage ADD COLUMN test_queries integer NOT NULL DEFAULT 0;
    CREATE TABLE telegram_owner_limits (
      owner_id text PRIMARY KEY,
      daily integer NOT NULL DEFAULT 0 CHECK (daily >= 0),
      testing integer NOT NULL DEFAULT 0 CHECK (testing >= 0)
    );
    CREATE TABLE telegram_visitors (
      bot_id bigint NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
      user_id bigint NOT NULL,
      minute_start timestamptz NOT NULL DEFAULT now(), minute_count integer NOT NULL DEFAULT 0,
      day date NOT NULL DEFAULT CURRENT_DATE, day_count integer NOT NULL DEFAULT 0,
      last_hash text, last_question_at timestamptz,
      warning_at timestamptz,
      strike_start timestamptz, strikes integer NOT NULL DEFAULT 0,
      blocked_until timestamptz, repeat_until timestamptz,
      notice_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(bot_id, user_id)
    );
    CREATE TABLE telegram_owner_rate (
      owner_id text PRIMARY KEY, window_start timestamptz NOT NULL DEFAULT now(),
      requests integer NOT NULL DEFAULT 0
    );
    CREATE TABLE telegram_security_notices (
      bot_id bigint PRIMARY KEY REFERENCES telegram_bots(id) ON DELETE CASCADE,
      owner_id text NOT NULL,
      pending integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(),
      last_sent_at timestamptz
    );
    CREATE TABLE telegram_queue_turns (
      bot_id bigint PRIMARY KEY, last_served timestamptz NOT NULL DEFAULT '-infinity'
    );
    CREATE INDEX telegram_updates_pending_bot ON telegram_updates(bot_id, id) WHERE NOT done;
    CREATE INDEX telegram_updates_done ON telegram_updates(id) WHERE done;
    CREATE INDEX telegram_visitors_cleanup ON telegram_visitors(updated_at);
  `);
}

export function down(pgm) {
  pgm.sql(`
    DROP INDEX telegram_updates_done, telegram_updates_pending_bot;
    DROP TABLE telegram_queue_turns, telegram_security_notices, telegram_owner_rate, telegram_visitors, telegram_owner_limits;
    ALTER TABLE telegram_usage DROP COLUMN test_queries;
    ALTER TABLE telegram_bots DROP COLUMN protection;
  `);
}
