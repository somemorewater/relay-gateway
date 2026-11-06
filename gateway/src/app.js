import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { query } from './db.js';
import { ingest } from './ingest.js';
import { verifierHealthy } from './verifier.js';

const h = (s) => createHash('sha256').update(s).digest();
const KEY_HASHES = config.apiKeys.map(h);
const STATUS_FOR = { invalid_request: 400, invalid_signature: 401, nonce_reused: 409 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function auth(req, res, next) {
  const given = h(String(req.header('x-api-key') || ''));
  if (KEY_HASHES.some((k) => timingSafeEqual(k, given))) return next();
  res.status(401).json({ error: 'missing or invalid x-api-key' });
}

export function buildApp(chains) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' }));

  app.get('/healthz', async (_req, res) => {
    const [db, verifier] = await Promise.all([query('SELECT 1').then(() => true, () => false), verifierHealthy()]);
    res.status(db && verifier ? 200 : 503).json({ ok: db && verifier, db, verifier });
  });

  app.use('/v1', auth);

  app.get('/v1/chains', (_req, res) => {
    res.json([...chains.values()].map((c) => ({ id: c.id, type: c.constructor.name })));
  });

  // Single relay request.
  app.post('/v1/relay', async (req, res, next) => {
    try {
      const [r] = await ingest([req.body], chains);
      if (r.status === 'rejected') return res.status(STATUS_FOR[r.code] || 400).json({ error: r.error, code: r.code });
      res.status(r.status === 'accepted' ? 202 : 200).json({ id: r.id, digest: r.digest, status: r.status });
    } catch (e) { next(e); }
  });

  // Batch endpoint: one Rust verification round-trip and one INSERT for the whole batch.
  app.post('/v1/relay/batch', async (req, res, next) => {
    try {
      const items = req.body?.requests;
      if (!Array.isArray(items) || !items.length || items.length > config.maxBatchItems) {
        return res.status(400).json({ error: `requests must be an array of 1..${config.maxBatchItems} items` });
      }
      res.status(207).json({ results: await ingest(items, chains) });
    } catch (e) { next(e); }
  });

  app.get('/v1/relay/:id', async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
      const { rows } = await query(
        `SELECT id, digest, sender_key, nonce, source_chain, dest_chain, status, attempts,
                dest_tx_hash, last_error, created_at, submitted_at, confirmed_at
           FROM relay_requests WHERE id = $1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      const { rows: events } = await query('SELECT event, detail, created_at FROM relay_events WHERE request_id = $1 ORDER BY id', [req.params.id]);
      res.json({ ...rows[0], events });
    } catch (e) { next(e); }
  });

  app.get('/v1/stats', async (_req, res, next) => {
    try {
      const { rows } = await query('SELECT status, count(*)::int AS n FROM relay_requests GROUP BY status');
      res.json(Object.fromEntries(rows.map((r) => [r.status, r.n])));
    } catch (e) { next(e); }
  });

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'body too large' });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}
