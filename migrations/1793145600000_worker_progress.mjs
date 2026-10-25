export function up(pgm) {
  pgm.sql(`
    CREATE TABLE worker_progress (
      name text PRIMARY KEY CHECK (name IN ('ingestion', 'telegram')),
      backend_pid integer NOT NULL,
      backend_start timestamptz NOT NULL,
      last_progress_at timestamptz NOT NULL
    );
  `);
}

export function down(pgm) {
  pgm.sql('DROP TABLE worker_progress;');
}
