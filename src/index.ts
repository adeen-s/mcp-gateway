#!/usr/bin/env node
import { loadConfig, ConfigError } from './config/loader.js';
import { createLogger } from './observability/logger.js';
import { initTracing } from './observability/tracing.js';
import { Gateway } from './server.js';

function configPathFromArgs(argv: string[]): string {
  const flagIndex = argv.findIndex((a) => a === '--config' || a === '-c');
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    return argv[flagIndex + 1];
  }
  return process.env.MCP_GATEWAY_CONFIG ?? 'config/gateway.yaml';
}

async function main(): Promise<void> {
  const configPath = configPathFromArgs(process.argv.slice(2));
  const config = await loadConfig(configPath);
  const logger = createLogger({ level: config.observability.logLevel });
  const tracing = await initTracing(config.observability.tracing, logger);

  const gateway = new Gateway({ config, configPath, logger });
  await gateway.start();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    void (async () => {
      try {
        await gateway.stop();
        await tracing?.shutdown();
        process.exit(0);
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'error during shutdown');
        process.exit(1);
      }
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => {
    logger.info('SIGHUP received, reloading configuration');
    gateway.reload().catch((err: unknown) => {
      logger.error({ err: (err as Error).message }, 'config reload failed');
    });
  });
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error('fatal:', err);
  }
  process.exit(1);
});
