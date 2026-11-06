import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const env = process.env;
const int = (k, d) => (env[k] !== undefined ? parseInt(env[k], 10) : d);
const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  role: env.ROLE || 'all', // all | api | worker
  port: int('PORT', 8080),
  databaseUrl: env.DATABASE_URL || 'postgres://relay:relay@localhost:5432/relay',
  verifierUrl: env.VERIFIER_URL || 'http://localhost:7001',
  apiKeys: (env.API_KEYS || 'dev-key').split(',').map((s) => s.trim()).filter(Boolean),
  chainsFile: env.CHAINS_FILE || path.join(here, '..', 'chains.json'),
  worker: {
    batchSize: int('WORKER_BATCH', 25),
    pollMs: int('WORKER_POLL_MS', 250),
    lockSecs: int('WORKER_LOCK_SECS', 30),
    maxAttempts: int('MAX_ATTEMPTS', 6),
    backoffBaseMs: int('BACKOFF_BASE_MS', 500),
    backoffMaxMs: int('BACKOFF_MAX_MS', 60_000),
    confirmPollSecs: int('CONFIRM_POLL_SECS', 1),
    confirmTimeoutMs: int('CONFIRM_TIMEOUT_MS', 10 * 60_000),
  },
  maxBatchItems: int('MAX_BATCH_ITEMS', 500),
};

export function loadChainConfigs() {
  return JSON.parse(readFileSync(config.chainsFile, 'utf8')).filter((c) => c.enabled !== false);
}
