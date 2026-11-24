import 'dotenv/config';
import { createApp, createServices } from './app.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { scheduleCleanup } from './services/cleanup.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
const services = createServices(db, config.retention, systemClock);
const stopCleanup = scheduleCleanup(
  db,
  services.shares,
  config.retention,
  systemClock,
  config.cleanupInterval,
);

const server = createApp(config, services).listen(config.port, () => {
  console.log(`uhabits-server listening on port ${config.port}${config.basePath}`);
  console.log(`Docs: ${config.basePath}/docs`);
});

function shutdown(): void {
  stopCleanup();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
