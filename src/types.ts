/** How a request was authenticated. */
export type AuthMethod = 'apiKey' | 'jwt' | 'mtls' | 'anonymous';

/** The identity every auth provider resolves to. */
export interface TenantIdentity {
  tenantId: string;
  method: AuthMethod;
  /** Provider-specific subject: key id, JWT sub, certificate CN, ... */
  subject?: string;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'UNAUTHENTICATED'
      | 'FORBIDDEN'
      | 'RATE_LIMITED'
      | 'QUOTA_EXCEEDED'
      | 'UPSTREAM_UNAVAILABLE'
      | 'UPSTREAM_TIMEOUT'
      | 'UNKNOWN_TOOL'
      | 'UNKNOWN_RESOURCE'
      | 'COLLISION',
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
