// End-to-end demo / smoke test. Exits non-zero if anything unexpected happens.
import assert from 'node:assert/strict';
import { newIdentity, makeRequest, post, api } from './client.mjs';

const alice = newIdentity();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('1) happy path: sim-alpha -> sim-beta');
const req = makeRequest(alice, { sourceChain: 'sim-alpha', destChain: 'sim-beta', nonce: Date.now(), payload: { to: '0xabc', amount: '42' } });
const ok = await post('/v1/relay', req);
console.log('  ', ok.status, ok.body);
assert.equal(ok.status, 202);

console.log('2) idempotent resubmit of the same request');
const dup = await post('/v1/relay', req);
console.log('  ', dup.status, dup.body);
assert.equal(dup.status, 200);
assert.equal(dup.body.id, ok.body.id);

console.log('3) replay: same nonce, different payload');
const replay = await post('/v1/relay', makeRequest(alice, { sourceChain: 'sim-alpha', destChain: 'sim-beta', nonce: req.nonce, payload: { to: '0xabc', amount: '9999' } }));
console.log('  ', replay.status, replay.body);
assert.equal(replay.status, 409);

console.log('4) tampered payload (signature no longer matches)');
const tampered = await post('/v1/relay', { ...makeRequest(alice, { sourceChain: 'sim-alpha', destChain: 'sim-beta', nonce: Date.now() + 1, payload: { amount: '1' } }), payload: { amount: '1000000' } });
console.log('  ', tampered.status, tampered.body);
assert.equal(tampered.status, 401);

console.log('5) bad API key');
const noauth = await fetch((process.env.GATEWAY_URL || 'http://localhost:8080') + '/v1/stats', { headers: { 'x-api-key': 'nope' } });
assert.equal(noauth.status, 401);

console.log('6) batch of 20 (sim-alpha is configured to fail ~20% of submissions -> exercises retries)');
const base = Date.now() * 1000;
const batch = Array.from({ length: 20 }, (_, i) => makeRequest(alice, { sourceChain: 'sim-beta', destChain: 'sim-alpha', nonce: base + i, payload: { i } }));
const b = await post('/v1/relay/batch', { requests: batch });
assert.equal(b.status, 207);
assert.ok(b.body.results.every((r) => r.status === 'accepted'));
const ids = [ok.body.id, ...b.body.results.map((r) => r.id)];

console.log('7) waiting for terminal states…');
const terminal = new Set(['confirmed', 'failed']);
let states;
for (let t = 0; t < 60; t++) {
  states = await Promise.all(ids.map(async (id) => (await api(`/v1/relay/${id}`)).body));
  if (states.every((s) => terminal.has(s.status))) break;
  await sleep(500);
}
const tally = {};
states.forEach((s) => (tally[s.status] = (tally[s.status] || 0) + 1));
console.log('   final:', tally, '| retried requests:', states.filter((s) => s.attempts > 1).length);
assert.ok(states.every((s) => terminal.has(s.status)), 'some requests never reached a terminal state');

const first = states[0];
console.log('   first request timeline:', first.events.map((e) => e.event).join(' -> '), '| dest tx', first.dest_tx_hash);
console.log('stats:', (await api('/v1/stats')).body);
console.log('\nDEMO OK');
