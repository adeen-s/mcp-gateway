import type { AuthConfig } from '../config/schema.js';
import { GatewayError, type TenantIdentity } from '../types.js';
import { ApiKeyAuthProvider } from './apikey.js';
import { JwtAuthProvider } from './jwt.js';
import { MtlsAuthProvider } from './mtls.js';
import type { AuthProvider, AuthRequestContext } from './provider.js';

/**
 * Runs configured providers in order; the first one that resolves an identity
 * wins. Falls back to the anonymous tenant when configured (dev/test only).
 */
export class AuthChain {
  constructor(
    private readonly providers: AuthProvider[],
    private readonly anonymousTenant?: string
  ) {}

  static fromConfig(config: AuthConfig): AuthChain {
    const providers: AuthProvider[] = config.providers.map((p) => {
      switch (p.type) {
        case 'apiKey':
          return new ApiKeyAuthProvider(p);
        case 'jwt':
          return new JwtAuthProvider(p);
        case 'mtls':
          return new MtlsAuthProvider(p);
      }
    });
    return new AuthChain(providers, config.anonymousTenant);
  }

  async authenticate(ctx: AuthRequestContext): Promise<TenantIdentity> {
    for (const provider of this.providers) {
      const identity = await provider.authenticate(ctx);
      if (identity) return identity;
    }
    if (this.anonymousTenant) {
      return { tenantId: this.anonymousTenant, method: 'anonymous' };
    }
    throw new GatewayError('authentication required', 'UNAUTHENTICATED');
  }
}
