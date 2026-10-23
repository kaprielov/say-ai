export function up(pgm) {
  pgm.sql(`
    ALTER TABLE knowledge_bases ADD COLUMN name text NOT NULL DEFAULT 'Knowledge base';
    ALTER TABLE knowledge_bases ADD CONSTRAINT knowledge_bases_id_owner_unique UNIQUE (id, owner_id);
    CREATE TABLE telegram_sessions (
      user_id bigint PRIMARY KEY,
      state text NOT NULL DEFAULT 'menu',
      knowledge_base_id uuid,
      draft_name text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE telegram_bots (
      id bigint PRIMARY KEY,
      owner_id text NOT NULL,
      username text NOT NULL,
      knowledge_base_id uuid,
      token_ciphertext text NOT NULL,
      webhook_secret text NOT NULL,
      enabled boolean NOT NULL DEFAULT false,
      FOREIGN KEY (knowledge_base_id, owner_id) REFERENCES knowledge_bases (id, owner_id)
    );
    CREATE TABLE telegram_updates (
      id bigserial PRIMARY KEY,
      bot_id bigint NOT NULL,
      update_id bigint NOT NULL,
      payload jsonb,
      attempts integer NOT NULL DEFAULT 0,
      done boolean NOT NULL DEFAULT false,
      available_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (bot_id, update_id)
    );
    CREATE INDEX telegram_updates_pending ON telegram_updates (id) WHERE NOT done;
    CREATE TABLE telegram_outbox (
      id bigserial PRIMARY KEY,
      bot_id bigint NOT NULL,
      method text NOT NULL DEFAULT 'sendMessage',
      payload jsonb NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE telegram_notifications (
      task_id uuid PRIMARY KEY REFERENCES ingestion_tasks (id),
      chat_id bigint NOT NULL
    );
    CREATE TABLE telegram_usage (
      owner_id text NOT NULL,
      day date NOT NULL DEFAULT CURRENT_DATE,
      queries integer NOT NULL DEFAULT 0,
      PRIMARY KEY (owner_id, day)
    );
  `);
}

export function down(pgm) {
  pgm.sql(`
    DROP TABLE telegram_usage, telegram_notifications, telegram_outbox, telegram_updates, telegram_bots, telegram_sessions;
    ALTER TABLE knowledge_bases DROP CONSTRAINT knowledge_bases_id_owner_unique;
    ALTER TABLE knowledge_bases DROP COLUMN name;
  `);
}
