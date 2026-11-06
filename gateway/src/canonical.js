// Canonical signing format shared by the gateway and clients.
// Clients sign: UTF-8 bytes of canonicalize({ v:1, sourceChain, destChain, nonce, payload })
// Keys sorted recursively, no whitespace.

export function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return (
    '{' +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalize(v[k]))
      .join(',') +
    '}'
  );
}

export function signingBytes({ sourceChain, destChain, nonce, payload }) {
  return Buffer.from(canonicalize({ v: 1, sourceChain, destChain, nonce, payload }), 'utf8');
}
