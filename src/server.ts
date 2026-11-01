import 'dotenv/config';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createPool } from './db.js';
import { startHoldSweeper } from './jobs/sweeper.js';
import { createLogger } from './logger.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const log = createLogger(config.logLevel, config.nodeEnv);
const pool = createPool({ url: config.databaseUrl, ssl: config.databaseSsl, max: config.databasePoolMax });
pool.on('error', (err) => log.error({ err }, 'idle pg client error'));

const { app } = createApp({ config, pool, log });
const stopSweeper = config.holdSweeperEnabled ? startHoldSweeper(pool, log) : () => {};

const server = app.listen(config.port, () => log.info({ port: config.port, env: config.nodeEnv }, 'Trim API listening'));

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  const force = setTimeout(() => {
    log.error('forced exit after timeout');
    process.exit(1);
  }, 15_000);
  force.unref();
  stopSweeper();
  server.close(async (err) => {
    if (err) log.error({ err }, 'error closing http server');
    try {
      await pool.end();
    } catch (e) {
      log.error({ err: e }, 'error closing pool');
    }
    process.exit(err ? 1 : 0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error({ err }, 'unhandledRejection'));
