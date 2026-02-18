import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { ZodError } from 'zod';
import { gatewayConfigSchema, type GatewayConfig } from './schema.js';

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: string[] = []
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ENV_PATTERN = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g;

/**
 * Interpolates `${ENV_VAR}` and `${ENV_VAR:-default}` placeholders in string
 * values. Missing variables without a default raise a ConfigError so that a
 * misconfigured deployment fails fast instead of running with empty secrets.
 */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_PATTERN, (_match, name: string, fallback: string | undefined) => {
      const resolved = env[name] ?? fallback;
      if (resolved === undefined) {
        throw new ConfigError(`environment variable "${name}" referenced in config is not set`);
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateEnv(v, env));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateEnv(v, env)])
    );
  }
  return value;
}

export function parseConfig(raw: unknown): GatewayConfig {
  try {
    return gatewayConfigSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
      throw new ConfigError(`invalid configuration:\n  - ${issues.join('\n  - ')}`, issues);
    }
    throw err;
  }
}

export async function loadConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<GatewayConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read config file "${path}": ${(err as Error).message}`);
  }
  const doc: unknown = parse(text);
  if (doc === null || typeof doc !== 'object') {
    throw new ConfigError(`config file "${path}" is empty or not a YAML mapping`);
  }
  return parseConfig(interpolateEnv(doc, env));
}
