import type { PoolClient } from 'pg';

// Call only from the worker's actual processing path while it owns its lock.
// A separate timer could mask a stalled loop. Keep writes bounded on idle loops.
export class WorkerProgress {
  private recordedAt = -Infinity;

  constructor(private readonly db: PoolClient, private readonly name: 'ingestion' | 'telegram') {}

  async record() {
    if (performance.now() - this.recordedAt < 10_000) return;
    await this.db.query(`
      INSERT INTO worker_progress(name, backend_pid, backend_start, last_progress_at)
      SELECT $1, pid, backend_start, clock_timestamp() FROM pg_stat_activity WHERE pid=pg_backend_pid()
      ON CONFLICT(name) DO UPDATE SET backend_pid=excluded.backend_pid,
        backend_start=excluded.backend_start, last_progress_at=excluded.last_progress_at
    `, [this.name]);
    this.recordedAt = performance.now();
  }
}
