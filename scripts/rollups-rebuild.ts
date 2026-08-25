/**
 * Rebuild `campaign_daily_stats` from `message_events`, from scratch.
 *
 * The rollup is derived and disposable; this command proves it. If a full rebuild
 * ever disagrees with what the incremental job produced, the incremental job has a
 * bug — and because the events are the source of truth, the truth is recoverable.
 * That is the property counters do not have.
 */
import { Pool } from 'pg';
import { rebuildRollups } from '../packages/worker/src/jobs/rollups.ts';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const db = new Pool({ connectionString: url });
try {
  const { rows } = await db.query<{ lo: Date | null; hi: Date | null }>(
    `SELECT min(occurred_at) AS lo, max(occurred_at) AS hi FROM message_events`,
  );
  const lo = rows[0]?.lo;
  const hi = rows[0]?.hi;
  if (!lo || !hi) {
    console.log('No events to roll up.');
  } else {
    await db.query('TRUNCATE campaign_daily_stats');
    const result = await rebuildRollups(db, { from: lo, to: hi });
    console.log(`Rebuilt ${result.rows} rows across ${result.days} days from the event store.`);
  }
} finally {
  await db.end();
}
