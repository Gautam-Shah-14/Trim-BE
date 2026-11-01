import { writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { buildOpenApi } from '../src/openapi.js';

// The generator never connects to a database; the values below are throwaway placeholders.
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://unused/unused', JWT_SECRET: 'x'.repeat(32), QR_SECRET: 'y'.repeat(32) });
const { api } = createApp({ config, pool: createPool({ url: config.databaseUrl, ssl: false, max: 1 }), log: createLogger('silent', 'test') });
const doc = stringify(buildOpenApi(api.routes), { lineWidth: 0 });
writeFileSync(new URL('../openapi.yaml', import.meta.url), doc);
console.log(`openapi.yaml written (${api.routes.length} operations)`);
process.exit(0);
