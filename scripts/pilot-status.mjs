import pg from 'pg';
import { pathToFileURL } from 'node:url';

export async function pilotStatus(db) {
  // One statement gives queues and lock observations a common snapshot. Only
  // aggregate metadata is selected; payloads and credentials never leave the DB.
  return (await db.query(`
    SELECT CURRENT_TIMESTAMP AS checked_at,
      json_build_object(
        'ingestion_lock_held', EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND classid=1792627200 AND objid=1 AND objsubid=2 AND granted),
        'telegram_lock_held', EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND classid=1792627200 AND objid=2 AND objsubid=2 AND granted)
      ) AS workers,
      json_build_object(
        'updates', (SELECT json_build_object(
          'pending',count(*),
          'due',count(*) FILTER(WHERE available_at<=now()),
          'deferred',count(*) FILTER(WHERE available_at>now()),
          'retrying',count(*) FILTER(WHERE attempts>0),
          'oldest_due_seconds',EXTRACT(EPOCH FROM now()-min(available_at) FILTER(WHERE available_at<=now()))
        ) FROM telegram_updates WHERE NOT done),
        'outbox', (SELECT json_build_object(
          'pending',count(*),
          'due',count(*) FILTER(WHERE available_at<=now()),
          'deferred',count(*) FILTER(WHERE available_at>now()),
          'retrying',count(*) FILTER(WHERE attempts>0),
          'oldest_due_seconds',EXTRACT(EPOCH FROM now()-min(available_at) FILTER(WHERE available_at<=now()))
        ) FROM telegram_outbox)
      ) AS telegram,
      (SELECT json_build_object(
        'pending',count(*) FILTER(WHERE status='pending'),
        'processing',count(*) FILTER(WHERE status='processing'),
        'failed',count(*) FILTER(WHERE status='failed'),
        'failed_last_24_hours',count(*) FILTER(WHERE status='failed' AND updated_at>=now()-interval '1 day'),
        'oldest_unfinished_seconds',EXTRACT(EPOCH FROM now()-min(created_at) FILTER(WHERE status IN ('pending','processing')))
      ) FROM ingestion_tasks) AS ingestion
  `)).rows[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1,
    connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  pool.on('error', () => { process.exitCode = 1; });
  try {
    if (!process.env.DATABASE_URL) throw new Error('Missing database configuration.');
    console.log(JSON.stringify(await pilotStatus(pool), null, 2));
  } catch {
    console.error(JSON.stringify({ error: 'pilot_status_unavailable', message: 'Check DATABASE_URL, database availability, and migrations.' }));
    process.exitCode = 1;
  } finally { await pool.end(); }
}
