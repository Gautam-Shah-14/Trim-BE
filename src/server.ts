import 'dotenv/config';
import http from 'node:http';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createPool } from './db.js';
import { scheduleRecurring } from './jobs/index.js';
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
const pool = createPool({
  url: config.databaseUrl, ssl: config.databaseSsl, sslCaFile: config.databaseSslCaFile || undefined, pooler: config.dbPooler, max: config.databasePoolMax,
  statementTimeoutMs: config.statementTimeoutMs, lockTimeoutMs: config.lockTimeoutMs, idleTxTimeoutMs: config.idleTxTimeoutMs,
});
if (config.nodeEnv === 'production' && !config.bffSharedSecret) {
  log.warn('BFF_SHARED_SECRET is not set: website visitors share the rate-limit bucket of the proxy IP. Set it on the API and on the website.');
}
pool.on('error', (err) => log.error({ err }, 'idle pg client error'));

const { app, deps, close } = createApp({ config, pool, log });
const mode = config.workerMode;
const consume = mode === 'worker' || mode === 'both';
// the memory/inline queues always run jobs inside the process that enqueues them
const serveHttp = mode === 'api' || mode === 'both';

try {
  if (config.queue.enabled) await deps.queue.start(consume);
  if (consume) scheduleRecurring(deps);
} catch (err) {
  log.error({ err }, 'queue failed to start');
  process.exit(1);
}

// worker-only processes still expose liveness/readiness so the host can supervise them
const server = serveHttp
  ? app.listen(config.port, () => log.info({ port: config.port, env: config.nodeEnv, mode, queue: deps.queue.driver, cache: config.cacheDriver }, 'Trim API listening'))
  : http
      .createServer((req, res) => {
        res.writeHead(req.url === '/health' || req.url === '/ready' ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'ok', mode }));
      })
      .listen(config.port, () => log.info({ port: config.port, mode }, 'Trim worker running'));

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down (draining)');
  const force = setTimeout(() => {
    log.error('forced exit after timeout');
    process.exit(1);
  }, 20_000);
  force.unref();
  server.close(async (err) => {
    if (err) log.error({ err }, 'error closing http server');
    try {
      await close(); // queue (graceful), cache, limiter
      await pool.end();
    } catch (e) {
      log.error({ err: e }, 'error during shutdown');
    }
    process.exit(err ? 1 : 0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  log.error({ err }, 'unhandledRejection');
  deps.captureException(err);
});
