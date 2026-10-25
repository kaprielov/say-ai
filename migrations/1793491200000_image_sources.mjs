export function up(pgm) {
  pgm.sql(`
    ALTER TABLE ingestion_tasks ALTER COLUMN source_text DROP NOT NULL;
    ALTER TABLE upload_draft_items ADD COLUMN caption text NOT NULL DEFAULT '' CHECK (length(caption)<=1024);
    CREATE TABLE image_storage_settings (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      owner_bytes bigint NOT NULL DEFAULT 200000000 CHECK (owner_bytes>=20000000)
    );
    INSERT INTO image_storage_settings DEFAULT VALUES;
    CREATE TABLE image_sources (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id text NOT NULL,
      ingestion_task_id uuid REFERENCES ingestion_tasks(id) ON DELETE CASCADE,
      draft_item_id bigint UNIQUE REFERENCES upload_draft_items(id) ON DELETE CASCADE,
      filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 120),
      caption text NOT NULL DEFAULT '' CHECK (length(caption)<=1024),
      original_bytes bytea CHECK (octet_length(original_bytes) BETWEEN 1 AND 20000000),
      reserved_bytes integer NOT NULL CHECK (reserved_bytes BETWEEN 0 AND 20000000),
      sha256 text,
      evidence jsonb,
      source_text text CHECK (octet_length(source_text)<=5242880),
      model text,
      prompt_revision text,
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (num_nonnulls(ingestion_task_id,draft_item_id)=1),
      CHECK (original_bytes IS NULL OR reserved_bytes=octet_length(original_bytes)),
      CHECK ((source_text IS NULL)=(evidence IS NULL)),
      CHECK (source_text IS NULL OR (model IS NOT NULL AND prompt_revision IS NOT NULL))
    );
    CREATE INDEX image_sources_owner ON image_sources(owner_id);
    CREATE INDEX image_sources_task ON image_sources(ingestion_task_id);
    CREATE FUNCTION guard_image_source() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_owner text; used_bytes bigint; quota bigint;
    BEGIN
      IF TG_OP='UPDATE' AND NEW.owner_id<>OLD.owner_id THEN RAISE EXCEPTION 'Image owner cannot change' USING ERRCODE='23514'; END IF;
      IF NEW.ingestion_task_id IS NOT NULL THEN
        SELECT kb.owner_id INTO target_owner FROM ingestion_tasks t JOIN knowledge_bases kb ON kb.id=t.knowledge_base_id WHERE t.id=NEW.ingestion_task_id;
      ELSE
        SELECT 'telegram:' || d.user_id::text INTO target_owner FROM upload_draft_items i JOIN upload_drafts d ON d.id=i.draft_id WHERE i.id=NEW.draft_item_id;
      END IF;
      IF target_owner IS NULL OR target_owner<>NEW.owner_id THEN RAISE EXCEPTION 'Image source owner mismatch' USING ERRCODE='23514'; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW.owner_id,29));
      SELECT COALESCE(sum(reserved_bytes),0) INTO used_bytes FROM image_sources WHERE owner_id=NEW.owner_id AND id<>NEW.id;
      SELECT owner_bytes INTO quota FROM image_storage_settings WHERE singleton;
      IF used_bytes+NEW.reserved_bytes>quota THEN RAISE EXCEPTION 'Image storage capacity is full' USING ERRCODE='P2001'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER image_source_guard BEFORE INSERT OR UPDATE ON image_sources FOR EACH ROW EXECUTE FUNCTION guard_image_source();
    CREATE FUNCTION check_ingestion_source() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE task_id uuid;
    BEGIN
      IF TG_TABLE_NAME='ingestion_tasks' THEN task_id=NEW.id;
      ELSE task_id=OLD.ingestion_task_id; END IF;
      IF EXISTS(SELECT 1 FROM ingestion_tasks t WHERE t.id=task_id AND t.source_text IS NULL
        AND NOT EXISTS(SELECT 1 FROM image_sources s WHERE s.ingestion_task_id=t.id AND s.original_bytes IS NOT NULL)) THEN
        RAISE EXCEPTION 'Ingestion requires text or a durable image' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER ingestion_source_required AFTER INSERT OR UPDATE ON ingestion_tasks
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ingestion_source();
    CREATE CONSTRAINT TRIGGER image_source_required AFTER DELETE OR UPDATE ON image_sources
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ingestion_source();
  `);
}
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM ingestion_tasks WHERE source_text IS NULL) THEN
        RAISE EXCEPTION 'Finish or remove pending image submissions before rolling back';
      END IF;
    END $$;
    DROP TRIGGER ingestion_source_required ON ingestion_tasks;
    DROP TABLE image_sources;
    DROP FUNCTION check_ingestion_source(), guard_image_source();
    DROP TABLE image_storage_settings;
    ALTER TABLE upload_draft_items DROP COLUMN caption;
    ALTER TABLE ingestion_tasks ALTER COLUMN source_text SET NOT NULL;
  `);
}
