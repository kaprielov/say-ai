import { pool } from '../src/db.js';

try {
  const result = await pool.query(`
    SELECT current_database() AS database,
           (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS pgvector_version,
           to_regclass('public.knowledge_bases') IS NOT NULL
             AND to_regclass('public.ingestion_tasks') IS NOT NULL
             AND to_regclass('public.content_versions') IS NOT NULL
             AND to_regclass('public.chunks') IS NOT NULL AS schema_ready
  `);
  const status = result.rows[0];
  if (!status.pgvector_version || !status.schema_ready) {
    throw new Error('Database schema is incomplete. Run npm run db:migrate.');
  }
  console.log(status);
} finally {
  await pool.end();
}
