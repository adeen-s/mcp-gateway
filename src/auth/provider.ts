import type { PeerCertificate } from 'node:tls';
import type { TenantIdentity } from '../types.js';

/** Transport-level facts an auth provider may inspect. */
export interface AuthRequestContext {
  /** Lower-cased header map of the incoming HTTP request. */
  headers: Record<string, string | string[] | undefined>;
  /** Verified TLS client certificate, when the listener runs with mTLS. */
  peerCertificate?: PeerCertificate;
}

/**
 * Pluggable authentication strategy. A provider either resolves the request
 * to a tenant identity, returns null to pass to the next provider, or throws
 * to hard-fail the request (e.g. a present-but-invalid JWT).
 */
export interface AuthProvider {
  readonly name: string;
  authenticate(ctx: AuthRequestContext): Promise<TenantIdentity | null>;
}

export function headerValue(
  headers: AuthRequestContext['headers'],
  name: string
): string | undefined {
  const v = headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}
