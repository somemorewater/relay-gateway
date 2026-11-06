import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';

// BIGINT -> number (nonces stay within Number.MAX_SAFE_INTEGER; enforced at validation).
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
export const query = (text, params) => pool.query(text, params);

export async function migrate() {
  const sql = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)'); // serialize concurrent boots
    await client.query(sql);
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}
