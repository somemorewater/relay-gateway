import { query } from './db.js';
import { signingBytes } from './canonical.js';
import { verifyBatch } from './verifier.js';

const HEX_KEY = /^[0-9a-fA-F]{64}$/;
const HEX_SIG = /^[0-9a-fA-F]{128}$/;
const MAX_PAYLOAD_BYTES = 64 * 1024;

function validateShape(it, chains) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) return 'request must be an object';
  if (!chains.has(it.sourceChain)) return `unknown sourceChain "${it.sourceChain}"`;
  if (!chains.has(it.destChain)) return `unknown destChain "${it.destChain}"`;
  if (it.sourceChain === it.destChain) return 'sourceChain and destChain must differ';
  if (!Number.isSafeInteger(it.nonce) || it.nonce < 0) return 'nonce must be a non-negative integer';
  if (typeof it.publicKey !== 'string' || !HEX_KEY.test(it.publicKey)) return 'publicKey must be 32 bytes of hex';
  if (typeof it.signature !== 'string' || !HEX_SIG.test(it.signature)) return 'signature must be 64 bytes of hex';
  if (!it.payload || typeof it.payload !== 'object' || Array.isArray(it.payload)) return 'payload must be an object';
  if (Buffer.byteLength(JSON.stringify(it.payload)) > MAX_PAYLOAD_BYTES) return 'payload too large';
  return chains.get(it.destChain).validatePayload(it.payload);
}

/**
 * Validate, verify (Rust core), and durably enqueue a batch of relay requests.
 * Returns one result per input, in order:
 *   { index, status: 'accepted'|'duplicate'|'rejected', id?, digest?, code?, error? }
 */
export async function ingest(items, chains) {
  const results = new Array(items.length);
  const candidates = [];

  items.forEach((raw, index) => {
    const err = validateShape(raw, chains);
    if (err) return (results[index] = { index, status: 'rejected', code: 'invalid_request', error: err });
    const it = { ...raw, publicKey: raw.publicKey.toLowerCase(), signature: raw.signature.toLowerCase() };
    candidates.push({ index, it, message: signingBytes(it).toString('hex') });
  });

  if (candidates.length) {
    const verdicts = await verifyBatch(
      candidates.map((c) => ({ id: String(c.index), publicKey: c.it.publicKey, message: c.message, signature: c.it.signature })),
    );
    const good = [];
    for (const c of candidates) {
      const v = verdicts.get(String(c.index));
      if (!v?.valid) results[c.index] = { index: c.index, status: 'rejected', code: 'invalid_signature', error: v?.error || 'verification failed' };
      else good.push({ ...c, digest: v.digest });
    }
    if (good.length) await enqueue(good, results);
  }
  return results;
}

async function enqueue(good, results) {
  const col = (f) => good.map(f);
  const { rows: inserted } = await query(
    `INSERT INTO relay_requests (digest, sender_key, nonce, source_chain, dest_chain, payload, signature)
     SELECT * FROM unnest($1::text[], $2::text[], $3::bigint[], $4::text[], $5::text[], $6::jsonb[], $7::text[])
     ON CONFLICT DO NOTHING
     RETURNING id, digest`,
    [
      col((g) => g.digest), col((g) => g.it.publicKey), col((g) => g.it.nonce),
      col((g) => g.it.sourceChain), col((g) => g.it.destChain),
      col((g) => JSON.stringify(g.it.payload)), col((g) => g.it.signature),
    ],
  );
  const byDigest = new Map(inserted.map((r) => [r.digest, r.id]));

  const leftovers = good.filter((g) => !byDigest.has(g.digest));
  const existing = new Map();
  if (leftovers.length) {
    const { rows } = await query('SELECT id, digest FROM relay_requests WHERE digest = ANY($1)', [leftovers.map((g) => g.digest)]);
    rows.forEach((r) => existing.set(r.digest, r.id));
  }

  // Event log for newly accepted requests (single statement).
  if (inserted.length) {
    await query(
      `INSERT INTO relay_events (request_id, event) SELECT unnest($1::uuid[]), 'accepted'`,
      [inserted.map((r) => r.id)],
    );
  }

  const seen = new Set();
  for (const g of good) {
    if (byDigest.has(g.digest) && !seen.has(g.digest)) {
      seen.add(g.digest);
      results[g.index] = { index: g.index, status: 'accepted', id: byDigest.get(g.digest), digest: g.digest };
    } else if (existing.has(g.digest) || seen.has(g.digest)) {
      results[g.index] = { index: g.index, status: 'duplicate', id: existing.get(g.digest) ?? byDigest.get(g.digest), digest: g.digest };
    } else {
      results[g.index] = { index: g.index, status: 'rejected', code: 'nonce_reused', error: 'nonce already used by this sender with a different message' };
    }
  }
}
