export function up(pgm) {
  pgm.sql(`
    CREATE TABLE owner_openai_keys (
      owner_id text PRIMARY KEY,
      ciphertext text NOT NULL,
      revision uuid NOT NULL DEFAULT gen_random_uuid(),
      valid boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE openai_key_attempts (
      owner_id text PRIMARY KEY,
      window_start timestamptz NOT NULL DEFAULT now(),
      attempts integer NOT NULL DEFAULT 1
    );
  `);
}
export function down(pgm) {
  pgm.sql('DROP TABLE openai_key_attempts, owner_openai_keys');
}
