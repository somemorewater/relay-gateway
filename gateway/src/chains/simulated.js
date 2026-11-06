import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const roll = (s) => parseInt(sha(s).slice(0, 8), 16) / 0xffffffff;

/**
 * Deterministic, stateless fake chain so that any worker process can both submit
 * and later check a transaction. Useful for demos, load tests and CI.
 */
export class SimulatedChain {
  constructor(cfg) {
    this.id = cfg.id;
    this.confirmMs = cfg.confirmMs ?? 1000;
    this.submitFailRate = cfg.submitFailRate ?? 0;
    this.revertRate = cfg.revertRate ?? 0;
    this.confirmations = cfg.confirmations ?? 1;
  }
  validatePayload() { return null; }

  async submit(req) {
    if (roll(`${this.id}:${req.digest}:${req.attempts}`) < this.submitFailRate) {
      throw new Error(`${this.id}: simulated RPC failure (attempt ${req.attempts})`);
    }
    return { txHash: '0x' + sha(`${this.id}:${req.digest}`) };
  }

  async getStatus(req) {
    const age = Date.now() - new Date(req.submitted_at).getTime();
    if (age < this.confirmMs) return { state: 'pending' };
    if (roll(`revert:${req.dest_tx_hash}`) < this.revertRate) return { state: 'failed', error: 'transaction reverted' };
    return { state: 'confirmed', confirmations: this.confirmations };
  }
}
