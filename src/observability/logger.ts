import { pino, type Logger } from 'pino';

export type { Logger };

export interface LoggerOptions {
  level?: string;
  /** Pretty-print for local development. */
  pretty?: boolean;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  return pino({
    name: 'mcp-gateway',
    level: opts.level ?? 'info',
    redact: {
      paths: ['req.headers.authorization', 'req.headers["x-api-key"]', '*.apiKey', '*.hmacSecret'],
      censor: '[redacted]',
    },
    base: { pid: process.pid },
  });
}

/** A logger that swallows everything; handy default for library-style use and tests. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
