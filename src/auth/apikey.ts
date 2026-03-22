import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiKeyProviderConfig } from '../config/schema.js';
import type { TenantIdentity } from '../types.js';
import { headerValue, type AuthProvider, type AuthRequestContext } from './provider.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Static API key authentication. Keys are compared by SHA-256 digest with a
 * constant-time comparison so the lookup does not leak key material through
 * timing side channels.
 */
export class ApiKeyAuthProvider implements AuthProvider {
  readonly name = 'apiKey';
  private readonly header: string;
  private readonly entries: { digest: Buffer; tenant: string; keyId: string }[];

  constructor(config: ApiKeyProviderConfig) {
    this.header = config.header.toLowerCase();
    this.entries = config.keys.map((k) => ({
      digest: digest(k.key),
      tenant: k.tenant,
      // Identify keys in audit logs by a short hash prefix, never the key itself.
      keyId: digest(k.key).toString('hex').slice(0, 12),
    }));
  }

  authenticate(ctx: AuthRequestContext): Promise<TenantIdentity | null> {
    const presented = headerValue(ctx.headers, this.header);
    if (!presented) return Promise.resolve(null);
    const presentedDigest = digest(presented);
    for (const entry of this.entries) {
      if (timingSafeEqual(presentedDigest, entry.digest)) {
        return Promise.resolve({
          tenantId: entry.tenant,
          method: 'apiKey',
          subject: `key:${entry.keyId}`,
        });
      }
    }
    return Promise.resolve(null);
  }
}
