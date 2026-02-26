import { describe, expect, it } from 'vitest';
import { ConfigError, interpolateEnv, parseConfig } from './loader.js';

const minimal = {
  upstreams: [{ name: 'echo', transport: { type: 'stdio', command: 'node' } }],
};

describe('config schema', () => {
  it('accepts a minimal config and fills defaults', () => {
    const cfg = parseConfig(minimal);
    expect(cfg.server.port).toBe(8080);
    expect(cfg.server.path).toBe('/mcp');
    expect(cfg.namespace.separator).toBe('__');
    expect(cfg.namespace.onCollision).toBe('error');
    expect(cfg.upstreams[0].timeoutMs).toBe(30_000);
    expect(cfg.upstreams[0].retry.maxAttempts).toBe(3);
    expect(cfg.upstreams[0].circuitBreaker.failureThreshold).toBe(5);
    expect(cfg.cache.enabled).toBe(false);
  });

  it('rejects an empty upstream list', () => {
    expect(() => parseConfig({ upstreams: [] })).toThrow(ConfigError);
  });

  it('rejects duplicate upstream names', () => {
    expect(() =>
      parseConfig({
        upstreams: [
          { name: 'a', transport: { type: 'stdio', command: 'x' } },
          { name: 'a', transport: { type: 'http', url: 'http://localhost:1' } },
        ],
      })
    ).toThrow(/duplicate upstream name/);
  });

  it('rejects invalid upstream names', () => {
    expect(() =>
      parseConfig({ upstreams: [{ name: 'has space', transport: { type: 'stdio', command: 'x' } }] })
    ).toThrow(ConfigError);
  });

  it('requires exactly one of jwksUri / hmacSecret for jwt providers', () => {
    const base = { ...minimal };
    expect(() =>
      parseConfig({ ...base, auth: { providers: [{ type: 'jwt' }] } })
    ).toThrow(ConfigError);
    expect(() =>
      parseConfig({
        ...base,
        auth: {
          providers: [
            { type: 'jwt', jwksUri: 'https://x/jwks.json', hmacSecret: 'oops-very-secret' },
          ],
        },
      })
    ).toThrow(ConfigError);
    const ok = parseConfig({
      ...base,
      auth: { providers: [{ type: 'jwt', hmacSecret: 'shhh-very-secret' }] },
    });
    expect(ok.auth.providers).toHaveLength(1);
  });

  it('requires audit.path when audit sink is file', () => {
    expect(() =>
      parseConfig({ ...minimal, observability: { audit: { enabled: true, sink: 'file' } } })
    ).toThrow(ConfigError);
  });

  it('collects readable issue paths', () => {
    try {
      parseConfig({ upstreams: [{ name: 'x', transport: { type: 'stdio' } }] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.join('\n')).toContain('upstreams.0.transport.command');
    }
  });
});

describe('env interpolation', () => {
  it('substitutes ${VAR} and ${VAR:-default}', () => {
    const env = { API_KEY: 'k123' } as NodeJS.ProcessEnv;
    expect(interpolateEnv('${API_KEY}', env)).toBe('k123');
    expect(interpolateEnv('redis://${REDIS_HOST:-localhost}:6379', env)).toBe(
      'redis://localhost:6379'
    );
    expect(interpolateEnv({ nested: ['${API_KEY}'] }, env)).toEqual({ nested: ['k123'] });
  });

  it('throws for missing variables without defaults', () => {
    expect(() => interpolateEnv('${DEFINITELY_NOT_SET_VAR}', {} as NodeJS.ProcessEnv)).toThrow(
      ConfigError
    );
  });

  it('leaves non-strings untouched', () => {
    expect(interpolateEnv(42, {} as NodeJS.ProcessEnv)).toBe(42);
    expect(interpolateEnv(null, {} as NodeJS.ProcessEnv)).toBeNull();
  });
});
