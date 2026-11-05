import { readFile } from 'node:fs/promises';
import { Storage } from '@google-cloud/storage';
import { loadConfig } from './config.js';
import { NotionClient } from './notion.js';
import { LessonPublisher } from './publish.js';
import { createApplication } from './server.js';
import { CloudStorageStore } from './storage.js';

const logger = {
  info: (entry) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', ...entry })),
  warn: (entry) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'WARNING', ...entry })),
  error: (entry) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'ERROR', ...entry })),
};

try {
  const config = await loadConfig();
  const storage = new Storage();
  const store = new CloudStorageStore(storage.bucket(config.bucket));
  const notion = new NotionClient(config, { logger });
  const publisher = new LessonPublisher(config, store, notion, { logger });
  const stylesheet = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  const server = createApplication({ config, store, publisher, stylesheet, logger });
  server.requestTimeout = 300_000;
  server.headersTimeout = 15_000;
  server.listen(config.port, '0.0.0.0', () => {
    logger.info({ event: 'server_started', port: config.port });
  });
  process.on('SIGTERM', () => {
    logger.info({ event: 'server_stopping' });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
} catch (error) {
  logger.error({ event: 'startup_failed', code: error.code ?? 'configuration_error' });
  process.exitCode = 1;
}
