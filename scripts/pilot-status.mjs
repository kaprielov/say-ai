import pg from 'pg';
import { pathToFileURL } from 'node:url';

export async function pilotStatus(db) {
  // One statement gives queues and lock observations a common snapshot. Only
  // aggregate metadata is selected; payloads and credentials never leave the DB.
  const status = (await db.query(`
    WITH worker_state AS (
      SELECT definition.name, l.pid IS NOT NULL AS lock_held,
        EXTRACT(EPOCH FROM clock_timestamp()-p.last_progress_at) AS progress_age_seconds
      FROM (VALUES ('ingestion',1),('telegram',2)) AS definition(name,lock_id)
      LEFT JOIN pg_locks l ON l.locktype='advisory' AND l.granted AND l.mode='ExclusiveLock'
        AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND l.classid=1792627200 AND l.objid=definition.lock_id AND l.objsubid=2
      LEFT JOIN pg_stat_activity a ON a.pid=l.pid
      LEFT JOIN worker_progress p ON p.name=definition.name AND p.backend_pid=l.pid
        AND p.backend_start=a.backend_start
    )
    SELECT CURRENT_TIMESTAMP AS checked_at,
      json_build_object(
        'ingestion_lock_held', (SELECT lock_held FROM worker_state WHERE name='ingestion'),
        'telegram_lock_held', (SELECT lock_held FROM worker_state WHERE name='telegram'),
        'ingestion', (SELECT json_build_object('progress_age_seconds',progress_age_seconds) FROM worker_state WHERE name='ingestion'),
        'telegram', (SELECT json_build_object('progress_age_seconds',progress_age_seconds) FROM worker_state WHERE name='telegram')
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
        'due',count(*) FILTER(WHERE status='pending' AND next_attempt_at<=now()),
        'deferred',count(*) FILTER(WHERE status='pending' AND next_attempt_at>now()),
        'processing',count(*) FILTER(WHERE status='processing'),
        'failed',count(*) FILTER(WHERE status='failed'),
        'failed_last_24_hours',count(*) FILTER(WHERE status='failed' AND updated_at>=now()-interval '1 day'),
        'oldest_unfinished_seconds',EXTRACT(EPOCH FROM now()-min(created_at) FILTER(WHERE status IN ('pending','processing')))
      ) FROM ingestion_tasks) AS ingestion
  `)).rows[0];
  status.stale_after_seconds = 300;
  status.attention_required = false;
  for (const name of ['ingestion', 'telegram']) {
    const worker = status.workers[name];
    const work = name === 'ingestion' ? status.ingestion.due + status.ingestion.processing
      : status.telegram.updates.due + status.telegram.outbox.due;
    const locked = status.workers[`${name}_lock_held`];
    worker.status = !locked ? (work ? 'missing' : 'stopped')
      : worker.progress_age_seconds === null ? 'unknown'
      : worker.progress_age_seconds > status.stale_after_seconds ? (work ? 'stalled' : 'unresponsive')
      : work ? 'working' : 'idle';
    if (['missing', 'unknown', 'stalled', 'unresponsive'].includes(worker.status)) status.attention_required = true;
  }
  return status;
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
