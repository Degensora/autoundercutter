import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, DEFAULT_SETTINGS } from './config.js';
import { openDb } from './db.js';
import { createMarketplace } from './marketplaces/index.js';
import { Engine } from './engine.js';
import { createRouter } from './routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const db = openDb(path.join(config.dataDir, 'autoundercutter.sqlite'), DEFAULT_SETTINGS);
const marketplace = createMarketplace(config, { db, log: (level, msg) => db.log(level, msg) });
const engine = new Engine({ db, marketplace });

const app = express();
app.disable('x-powered-by');
app.use('/api', createRouter({ db, engine, marketplace, config }));
app.use(express.static(path.join(here, '..', 'public')));

const server = app.listen(config.port, () => {
  const s = marketplace.status();
  console.log(`AutoUndercutter listening on http://localhost:${config.port}`);
  console.log(`Marketplace: ${marketplace.label}${s.username ? ` (${s.username})` : ''}`);
  const settings = db.getSettings();
  console.log(`Dry run: ${settings.dryRun ? 'ON (no prices will be changed)' : 'OFF (prices WILL be changed)'} · undercut $${settings.undercutAmount} · every ${settings.pollIntervalSec}s`);
  db.log('info', `Started. Marketplace: ${marketplace.label}. Dry run ${settings.dryRun ? 'on' : 'off'}.`);
  engine.start();
});

function shutdown() {
  engine.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
