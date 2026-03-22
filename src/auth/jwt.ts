import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { JwtProviderConfig } from '../config/schema.js';
import { GatewayError, type TenantIdentity } from '../types.js';
import { headerValue, type AuthProvider, type AuthRequestContext } from './provider.js';

/**
 * OAuth2 bearer token authentication with JWT validation via either a remote
 * JWKS endpoint (RS256 and friends) or a shared HMAC secret (HS256).
 *
 * Returns null when no bearer token is present (lets the next provider try),
 * but throws UNAUTHENTICATED when a token is present and invalid — a bad
 * token should never silently fall through to anonymous access.
 */
export class JwtAuthProvider implements AuthProvider {
  readonly name = 'jwt';
  private readonly key: JWTVerifyGetKey | Uint8Array;

  constructor(private readonly config: JwtProviderConfig) {
    if (config.jwksUri) {
      this.key = createRemoteJWKSet(new URL(config.jwksUri));
    } else if (config.hmacSecret) {
      this.key = new TextEncoder().encode(config.hmacSecret);
    } else {
      throw new Error('jwt provider requires jwksUri or hmacSecret');
    }
  }

  async authenticate(ctx: AuthRequestContext): Promise<TenantIdentity | null> {
    const authz = headerValue(ctx.headers, 'authorization');
    if (!authz?.toLowerCase().startsWith('bearer ')) return null;
    const token = authz.slice('bearer '.length).trim();
    if (!token) return null;

    let payload: JWTPayload;
    try {
      const verified =
        this.key instanceof Uint8Array
          ? await jwtVerify(token, this.key, this.verifyOptions())
          : await jwtVerify(token, this.key, this.verifyOptions());
      payload = verified.payload;
    } catch (err) {
      throw new GatewayError(`invalid bearer token: ${(err as Error).message}`, 'UNAUTHENTICATED');
    }

    const tenant = payload[this.config.tenantClaim];
    if (typeof tenant !== 'string' || tenant.length === 0) {
      throw new GatewayError(
        `bearer token is valid but missing the "${this.config.tenantClaim}" claim`,
        'UNAUTHENTICATED'
      );
    }
    return {
      tenantId: tenant,
      method: 'jwt',
      subject: typeof payload.sub === 'string' ? payload.sub : undefined,
    };
  }

  private verifyOptions() {
    return {
      issuer: this.config.issuer,
      audience: this.config.audience,
      clockTolerance: this.config.clockToleranceSec,
    };
  }
}
