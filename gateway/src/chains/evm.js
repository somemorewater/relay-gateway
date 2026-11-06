/**
 * EVM JSON-RPC adapter. The client supplies a fully-signed destination transaction in
 * payload.rawTx; the gateway authenticates the relay request (Ed25519), then broadcasts it.
 * Rebroadcasting the same raw tx is idempotent on-chain, which makes retries safe.
 */
export class EvmChain {
  constructor(cfg) {
    this.id = cfg.id;
    this.rpcUrl = cfg.rpcUrl;
    this.confirmations = cfg.confirmations ?? 2;
  }

  validatePayload(p) {
    return typeof p?.rawTx === 'string' && /^0x[0-9a-fA-F]+$/.test(p.rawTx)
      ? null
      : 'payload.rawTx must be a 0x-prefixed hex string for EVM chains';
  }

  async rpc(method, params) {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`${this.id}: RPC HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`${this.id}: ${body.error.message}`);
    return body.result;
  }

  async submit(req) {
    return { txHash: await this.rpc('eth_sendRawTransaction', [req.payload.rawTx]) };
  }

  async getStatus(req) {
    const receipt = await this.rpc('eth_getTransactionReceipt', [req.dest_tx_hash]);
    if (!receipt) return { state: 'pending' };
    if (receipt.status === '0x0') return { state: 'failed', error: 'transaction reverted' };
    const head = parseInt(await this.rpc('eth_blockNumber', []), 16);
    const confs = head - parseInt(receipt.blockNumber, 16) + 1;
    return confs >= this.confirmations ? { state: 'confirmed', confirmations: confs } : { state: 'pending' };
  }
}
