import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, signingBytes } from '../src/canonical.js';

test('canonicalize sorts keys recursively and is whitespace-free', () => {
  assert.equal(canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
});

test('signingBytes is independent of key order', () => {
  const a = signingBytes({ sourceChain: 'x', destChain: 'y', nonce: 1, payload: { a: 1, b: 2 } });
  const b = signingBytes({ payload: { b: 2, a: 1 }, nonce: 1, destChain: 'y', sourceChain: 'x' });
  assert.deepEqual(a, b);
});

test('signed message binds chains and nonce (no cross-chain replay)', () => {
  const base = { sourceChain: 'x', destChain: 'y', nonce: 1, payload: {} };
  assert.notDeepEqual(signingBytes(base), signingBytes({ ...base, destChain: 'z' }));
  assert.notDeepEqual(signingBytes(base), signingBytes({ ...base, nonce: 2 }));
});
