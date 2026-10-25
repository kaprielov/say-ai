export function up(pgm) {
  pgm.sql(`
    CREATE TABLE upload_drafts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id bigint NOT NULL,
      knowledge_base_id uuid REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting','queued','preparing','submitted','cancelled')),
      attempts integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
      task_id uuid REFERENCES ingestion_tasks(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX upload_drafts_open_owner ON upload_drafts(user_id)
      WHERE status IN ('collecting','queued','preparing');
    CREATE INDEX upload_drafts_queue ON upload_drafts(available_at) WHERE status='queued';
    CREATE TABLE upload_draft_items (
      id bigserial PRIMARY KEY,
      draft_id uuid NOT NULL REFERENCES upload_drafts(id) ON DELETE CASCADE,
      message_id bigint NOT NULL,
      filename text NOT NULL,
      file_id text,
      declared_bytes integer CHECK (declared_bytes BETWEEN 0 AND 20000000),
      actual_bytes integer CHECK (actual_bytes BETWEEN 0 AND 20000000),
      source_text text CHECK (octet_length(source_text) <= 5242880),
      error_message text,
      UNIQUE (draft_id, message_id)
    );
    ALTER TABLE telegram_sessions ADD COLUMN upload_draft_id uuid REFERENCES upload_drafts(id) ON DELETE SET NULL;
  `);
}

export function down(pgm) {
  pgm.sql(`ALTER TABLE telegram_sessions DROP COLUMN upload_draft_id;
    DROP TABLE upload_draft_items, upload_drafts;`);
}
