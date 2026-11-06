// Minimal client helpers: key generation, request signing, HTTP calls.
import { generateKeyPairSync, sign } from 'node:crypto';
import { signingBytes } from '../gateway/src/canonical.js';

export const BASE = process.env.GATEWAY_URL || 'http://localhost:8080';
export const API_KEY = process.env.API_KEY || 'dev-key';

export function newIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // SPKI DER for Ed25519 = 12-byte prefix + 32-byte raw key
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  return { privateKey, pub };
}

export function makeRequest(identity, { sourceChain, destChain, nonce, payload }) {
  const body = { sourceChain, destChain, nonce, payload };
  const signature = sign(null, signingBytes(body), identity.privateKey).toString('hex');
  return { ...body, publicKey: identity.pub, signature };
}

export async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, ...(init.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
export const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
