export function up(pgm) {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE knowledge_bases (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id text NOT NULL CHECK (length(btrim(owner_id)) > 0),
      active_version_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX knowledge_bases_owner_idx ON knowledge_bases (owner_id);

    CREATE TABLE ingestion_tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases (id),
      source_text text NOT NULL CHECK (length(btrim(source_text)) > 0),
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
      attempts_started integer NOT NULL DEFAULT 0 CHECK (attempts_started BETWEEN 0 AND 3),
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      error_code text,
      error_message text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, knowledge_base_id),
      CHECK (status NOT IN ('processing', 'ready') OR attempts_started > 0),
      CHECK (status <> 'pending' OR attempts_started < 3)
    );
    CREATE UNIQUE INDEX ingestion_tasks_one_unfinished_per_kb
      ON ingestion_tasks (knowledge_base_id) WHERE status IN ('pending', 'processing');
    CREATE INDEX ingestion_tasks_pending_idx ON ingestion_tasks (next_attempt_at)
      WHERE status = 'pending';
    CREATE INDEX ingestion_tasks_history_idx ON ingestion_tasks (knowledge_base_id, created_at DESC);

    CREATE TABLE content_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases (id),
      ingestion_task_id uuid NOT NULL,
      attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
      status text NOT NULL DEFAULT 'building' CHECK (status IN ('building', 'ready', 'failed')),
      embedding_model text NOT NULL CHECK (length(btrim(embedding_model)) > 0),
      embedding_dimensions integer NOT NULL CHECK (embedding_dimensions BETWEEN 1 AND 16000),
      chunking_config jsonb NOT NULL CHECK (jsonb_typeof(chunking_config) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      ready_at timestamptz,
      UNIQUE (id, knowledge_base_id),
      UNIQUE (id, embedding_dimensions),
      UNIQUE (ingestion_task_id, attempt_number),
      FOREIGN KEY (ingestion_task_id, knowledge_base_id)
        REFERENCES ingestion_tasks (id, knowledge_base_id),
      CHECK ((status = 'ready') = (ready_at IS NOT NULL))
    );
    CREATE INDEX content_versions_kb_idx ON content_versions (knowledge_base_id);

    ALTER TABLE knowledge_bases ADD CONSTRAINT knowledge_bases_active_version_fk
      FOREIGN KEY (active_version_id, id) REFERENCES content_versions (id, knowledge_base_id);

    CREATE TABLE chunks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      version_id uuid NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      text text NOT NULL CHECK (length(btrim(text)) > 0),
      token_count integer NOT NULL CHECK (token_count > 0),
      embedding_dimensions integer NOT NULL,
      embedding vector NOT NULL,
      UNIQUE (version_id, position),
      FOREIGN KEY (version_id, embedding_dimensions)
        REFERENCES content_versions (id, embedding_dimensions) ON DELETE CASCADE,
      CHECK (vector_dims(embedding) = embedding_dimensions),
      CHECK (vector_norm(embedding) > 0)
    );
  `);
}

export function down(pgm) {
  pgm.sql(`
    DROP TABLE chunks;
    ALTER TABLE knowledge_bases DROP CONSTRAINT knowledge_bases_active_version_fk;
    DROP TABLE content_versions;
    DROP TABLE ingestion_tasks;
    DROP TABLE knowledge_bases;
  `);
  // Keep the extension: it may also be used by other schemas in the database.
}
