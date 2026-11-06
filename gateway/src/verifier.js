import { config } from './config.js';

/** items: [{ id, publicKey, message(hex), signature }] -> Map(id -> { valid, digest, error }) */
export async function verifyBatch(items) {
  const res = await fetch(`${config.verifierUrl}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`verifier responded ${res.status}`);
  const { results } = await res.json();
  return new Map(results.map((r) => [r.id, r]));
}

export async function verifierHealthy() {
  try {
    const r = await fetch(`${config.verifierUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}
