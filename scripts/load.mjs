// Ingest throughput test: N signed requests sent through /v1/relay/batch.
import { newIdentity, makeRequest, post, api } from './client.mjs';

const TOTAL = parseInt(process.env.TOTAL || '5000', 10);
const BATCH = parseInt(process.env.BATCH || '250', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);

const senders = Array.from({ length: 20 }, newIdentity);
const nonceBase = Date.now() * 1000;
console.log(`signing ${TOTAL} requests…`);
const all = Array.from({ length: TOTAL }, (_, i) =>
  makeRequest(senders[i % senders.length], { sourceChain: 'sim-alpha', destChain: 'sim-beta', nonce: nonceBase + i, payload: { i } }));

const batches = [];
for (let i = 0; i < all.length; i += BATCH) batches.push(all.slice(i, i + BATCH));

let accepted = 0, rejected = 0;
const t0 = performance.now();
async function lane() {
  while (batches.length) {
    const { body } = await post('/v1/relay/batch', { requests: batches.pop() });
    for (const r of body.results) r.status === 'accepted' ? accepted++ : rejected++;
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, lane));
const secs = (performance.now() - t0) / 1000;
console.log(`ingested ${accepted} (rejected ${rejected}) in ${secs.toFixed(2)}s -> ${(accepted / secs).toFixed(0)} verified+persisted req/s`);
console.log('stats:', (await api('/v1/stats')).body);
