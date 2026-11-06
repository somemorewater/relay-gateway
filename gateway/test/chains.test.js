import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulatedChain } from '../src/chains/simulated.js';
import { EvmChain } from '../src/chains/evm.js';

test('simulated chain is deterministic and stateless', async () => {
  const c = new SimulatedChain({ id: 'sim', confirmMs: 0 });
  const req = { digest: 'abc', attempts: 1 };
  const a = await c.submit(req);
  const b = await new SimulatedChain({ id: 'sim' }).submit(req);
  assert.equal(a.txHash, b.txHash);
  assert.equal((await c.getStatus({ ...req, dest_tx_hash: a.txHash, submitted_at: new Date(Date.now() - 10) })).state, 'confirmed');
});

test('simulated chain reports pending until confirmMs elapses', async () => {
  const c = new SimulatedChain({ id: 'sim', confirmMs: 60_000 });
  assert.equal((await c.getStatus({ dest_tx_hash: '0x1', submitted_at: new Date() })).state, 'pending');
});

test('simulated submit failure is attempt-dependent (so retries can succeed)', async () => {
  const c = new SimulatedChain({ id: 'sim', submitFailRate: 0.5 });
  const outcomes = new Set();
  for (let attempts = 1; attempts <= 20; attempts++) {
    outcomes.add(await c.submit({ digest: 'd', attempts }).then(() => 'ok', () => 'fail'));
  }
  assert.deepEqual([...outcomes].sort(), ['fail', 'ok']);
});

test('EVM adapter validates rawTx', () => {
  const c = new EvmChain({ id: 'evm', rpcUrl: 'http://x' });
  assert.equal(c.validatePayload({ rawTx: '0x02f8' }), null);
  assert.ok(c.validatePayload({ rawTx: 'nope' }));
  assert.ok(c.validatePayload({}));
});
