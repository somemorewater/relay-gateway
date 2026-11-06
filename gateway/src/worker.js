import os from 'node:os';
import { query } from './db.js';
import { config } from './config.js';

const W = config.worker;
const WORKER_ID = `${os.hostname()}:${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), `[worker ${process.pid}]`, ...a);

const event = (id, name, detail) =>
  query('INSERT INTO relay_events (request_id, event, detail) VALUES ($1,$2,$3)', [id, name, detail ? JSON.stringify(detail) : null]);

/**
 * Claim work with SELECT ... FOR UPDATE SKIP LOCKED so any number of worker processes
 * (or hosts) can run concurrently without double-processing. Expired 'processing' locks
 * (crashed workers) are re-claimed automatically.
 */
async function claimPending() {
  const { rows } = await query(
    `UPDATE relay_requests SET status='processing', attempts = attempts + 1, locked_by=$1,
            locked_until = now() + make_interval(secs => $2), updated_at = now()
      WHERE id IN (
        SELECT id FROM relay_requests
         WHERE (status='pending' AND next_attempt_at <= now())
            OR (status='processing' AND locked_until < now())
         ORDER BY next_attempt_at, created_at
         FOR UPDATE SKIP LOCKED LIMIT $3)
      RETURNING *`,
    [WORKER_ID, W.lockSecs, W.batchSize],
  );
  return rows;
}

async function claimSubmitted() {
  const { rows } = await query(
    `UPDATE relay_requests SET next_attempt_at = now() + make_interval(secs => $1)
      WHERE id IN (
        SELECT id FROM relay_requests
         WHERE status='submitted' AND next_attempt_at <= now()
         ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT $2)
      RETURNING *`,
    [W.confirmPollSecs, W.batchSize],
  );
  return rows;
}

async function relayOne(row, chains) {
  const chain = chains.get(row.dest_chain);
  try {
    if (!chain) throw Object.assign(new Error(`chain ${row.dest_chain} not configured`), { fatal: true });
    const { txHash } = await chain.submit(row);
    await query(
      `UPDATE relay_requests SET status='submitted', dest_tx_hash=$2, submitted_at=now(), last_error=NULL,
              locked_by=NULL, locked_until=NULL, next_attempt_at = now() + make_interval(secs => $3), updated_at=now()
        WHERE id=$1 AND locked_by=$4`,
      [row.id, txHash, W.confirmPollSecs, WORKER_ID],
    );
    await event(row.id, 'submitted', { txHash, attempt: row.attempts });
  } catch (err) {
    const terminal = err.fatal || row.attempts >= W.maxAttempts;
    const delay = Math.min(W.backoffBaseMs * 2 ** (row.attempts - 1), W.backoffMaxMs) * (0.75 + Math.random() * 0.5);
    await query(
      `UPDATE relay_requests SET status=$2, last_error=$3, locked_by=NULL, locked_until=NULL,
              next_attempt_at = now() + make_interval(secs => $4), updated_at=now()
        WHERE id=$1 AND locked_by=$5`,
      [row.id, terminal ? 'failed' : 'pending', err.message, delay / 1000, WORKER_ID],
    );
    await event(row.id, terminal ? 'failed' : 'retry_scheduled', { error: err.message, attempt: row.attempts, delayMs: terminal ? 0 : Math.round(delay) });
  }
}

async function checkOne(row, chains) {
  const finish = async (status, error) => {
    await query(
      `UPDATE relay_requests SET status=$2, last_error=$3, confirmed_at = CASE WHEN $2='confirmed' THEN now() END, updated_at=now()
        WHERE id=$1 AND status='submitted'`,
      [row.id, status, error ?? null],
    );
    await event(row.id, status, error ? { error } : { txHash: row.dest_tx_hash });
  };
  try {
    const s = await chains.get(row.dest_chain).getStatus(row);
    if (s.state === 'confirmed') return finish('confirmed');
    if (s.state === 'failed') return finish('failed', s.error);
    if (Date.now() - new Date(row.submitted_at).getTime() > W.confirmTimeoutMs) return finish('failed', 'confirmation timeout');
  } catch (err) {
    log('status check error', row.id, err.message); // transient RPC error: retried on next poll
  }
}

export function startWorker(chains) {
  let running = true;
  const loop = (async () => {
    log(`started (${WORKER_ID})`);
    while (running) {
      try {
        const [pending, submitted] = await Promise.all([claimPending(), claimSubmitted()]);
        await Promise.all([
          ...pending.map((r) => relayOne(r, chains)),
          ...submitted.map((r) => checkOne(r, chains)),
        ]);
        if (!pending.length && !submitted.length) await sleep(W.pollMs);
      } catch (err) {
        log('loop error', err.message);
        await sleep(1000);
      }
    }
  })();
  return async () => { running = false; await loop; };
}
