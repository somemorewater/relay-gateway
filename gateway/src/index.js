import { config } from './config.js';
import { migrate, pool } from './db.js';
import { buildRegistry } from './chains/index.js';
import { buildApp } from './app.js';
import { startWorker } from './worker.js';

const chains = buildRegistry();
await migrate();

const stops = [];
if (config.role === 'all' || config.role === 'api') {
  const server = buildApp(chains).listen(config.port, () => console.log(`API listening on :${config.port} (chains: ${[...chains.keys()].join(', ')})`));
  stops.push(() => new Promise((r) => server.close(r)));
}
if (config.role === 'all' || config.role === 'worker') stops.push(startWorker(chains));

async function shutdown() {
  console.log('shutting down…');
  await Promise.all(stops.map((s) => s()));
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
