import { z } from 'zod';

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

export const stdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  cwd: z.string().optional(),
});

export const httpTransportSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
});

export const sseTransportSchema = z.object({
  type: z.literal('sse'),
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
});

export const transportSchema = z.discriminatedUnion('type', [
  stdioTransportSchema,
  httpTransportSchema,
  sseTransportSchema,
]);

// ---------------------------------------------------------------------------
// Resilience
// ---------------------------------------------------------------------------

export const retrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  baseDelayMs: z.number().int().min(1).default(200),
  maxDelayMs: z.number().int().min(1).default(5_000),
  jitter: z.boolean().default(true),
});

export const circuitBreakerSchema = z.object({
  enabled: z.boolean().default(true),
  failureThreshold: z.number().int().min(1).default(5),
  successThreshold: z.number().int().min(1).default(2),
  openDurationMs: z.number().int().min(100).default(30_000),
  halfOpenMaxConcurrent: z.number().int().min(1).default(1),
});

// ---------------------------------------------------------------------------
// Upstreams
// ---------------------------------------------------------------------------

export const upstreamSchema = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'upstream name must be alphanumeric (plus - and _)'),
  transport: transportSchema,
  timeoutMs: z.number().int().min(1).default(30_000),
  healthCheckIntervalMs: z.number().int().min(1_000).default(15_000),
  retry: retrySchema.default({}),
  circuitBreaker: circuitBreakerSchema.default({}),
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const apiKeyEntrySchema = z.object({
  key: z.string().min(8),
  tenant: z.string().min(1),
});

export const apiKeyProviderSchema = z.object({
  type: z.literal('apiKey'),
  header: z.string().default('x-api-key'),
  keys: z.array(apiKeyEntrySchema).default([]),
});

export const jwtProviderSchema = z
  .object({
    type: z.literal('jwt'),
    issuer: z.string().optional(),
    audience: z.string().optional(),
    /** Remote JWKS endpoint, e.g. https://auth.example.com/.well-known/jwks.json */
    jwksUri: z.string().url().optional(),
    /** Shared HMAC secret (HS256). Prefer ${ENV} interpolation over inline values. */
    hmacSecret: z.string().optional(),
    /** JWT claim that carries the tenant id. */
    tenantClaim: z.string().default('tenant'),
    clockToleranceSec: z.number().int().min(0).default(5),
  })
  .refine((v) => Boolean(v.jwksUri) !== Boolean(v.hmacSecret), {
    message: 'jwt provider requires exactly one of jwksUri or hmacSecret',
  });

export const mtlsCertEntrySchema = z
  .object({
    /** SHA-256 fingerprint of the client certificate (colon separated or plain hex). */
    fingerprint256: z.string().optional(),
    /** Common Name of the client certificate subject. */
    subjectCN: z.string().optional(),
    tenant: z.string().min(1),
  })
  .refine((v) => v.fingerprint256 || v.subjectCN, {
    message: 'mtls cert entry requires fingerprint256 or subjectCN',
  });

export const mtlsProviderSchema = z.object({
  type: z.literal('mtls'),
  certs: z.array(mtlsCertEntrySchema).default([]),
});

// Note: z.union (not discriminatedUnion) because jwtProviderSchema carries a refinement.
export const authProviderSchema = z.union([
  apiKeyProviderSchema,
  jwtProviderSchema,
  mtlsProviderSchema,
]);

export const authSchema = z.object({
  providers: z.array(authProviderSchema).default([]),
  /** Allow unauthenticated requests, mapped to this tenant id. Dev only. */
  anonymousTenant: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Tenants / RBAC / limits
// ---------------------------------------------------------------------------

export const rbacSchema = z.object({
  allowTools: z.array(z.string()).optional(),
  denyTools: z.array(z.string()).default([]),
  allowResources: z.array(z.string()).optional(),
  denyResources: z.array(z.string()).default([]),
});

export const bucketSchema = z.object({
  /** Sustained refill rate, tokens per second. */
  ratePerSec: z.number().positive(),
  /** Bucket capacity (burst size). */
  burst: z.number().int().min(1),
});

export const tenantRateLimitSchema = z.object({
  requests: bucketSchema.optional(),
  perTool: z.record(bucketSchema).default({}),
  /** Hard daily quota (UTC day). Unset = unlimited. */
  dailyQuota: z.number().int().min(1).optional(),
});

export const tenantSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  rbac: rbacSchema.default({}),
  rateLimit: tenantRateLimitSchema.default({}),
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export const cacheSchema = z.object({
  enabled: z.boolean().default(false),
  backend: z.enum(['memory', 'redis']).default('memory'),
  ttlSeconds: z.number().int().min(1).default(60),
  maxEntries: z.number().int().min(1).default(10_000),
  /** Namespaced tool name globs considered idempotent and safe to cache. */
  tools: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export const observabilitySchema = z.object({
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  metrics: z
    .object({
      enabled: z.boolean().default(true),
      path: z.string().default('/metrics'),
    })
    .default({}),
  tracing: z
    .object({
      enabled: z.boolean().default(false),
      serviceName: z.string().default('mcp-gateway'),
      otlpEndpoint: z.string().url().optional(),
    })
    .default({}),
  audit: z
    .object({
      enabled: z.boolean().default(true),
      sink: z.enum(['stdout', 'file']).default('stdout'),
      path: z.string().optional(),
    })
    .default({})
    .refine((v) => v.sink !== 'file' || Boolean(v.path), {
      message: 'audit.path is required when audit.sink is "file"',
    }),
});

// ---------------------------------------------------------------------------
// Server / admin / redis / namespace
// ---------------------------------------------------------------------------

export const tlsSchema = z.object({
  certFile: z.string(),
  keyFile: z.string(),
  /** CA bundle used to verify client certificates (enables mTLS). */
  caFile: z.string().optional(),
  requestClientCert: z.boolean().default(false),
});

export const serverSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().int().min(0).max(65_535).default(8080),
  path: z.string().regex(/^\//).default('/mcp'),
  tls: tlsSchema.optional(),
});

export const adminSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65_535).default(9090),
  /** Bearer token required for /admin/* endpoints. Use ${ENV} interpolation. */
  token: z.string().optional(),
});

export const redisSchema = z.object({
  url: z.string().default('redis://localhost:6379'),
  keyPrefix: z.string().default('mcpgw:'),
});

export const namespaceSchema = z.object({
  separator: z.string().min(1).max(4).default('__'),
  /**
   * What to do when two upstreams expose the same namespaced name:
   *  - error: refuse to start / surface the conflict
   *  - first: first upstream in config order wins
   */
  onCollision: z.enum(['error', 'first']).default('error'),
});

export const rateLimitGlobalSchema = z.object({
  backend: z.enum(['memory', 'redis']).default('memory'),
});

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export const gatewayConfigSchema = z.object({
  server: serverSchema.default({}),
  admin: adminSchema.default({}),
  namespace: namespaceSchema.default({}),
  upstreams: z
    .array(upstreamSchema)
    .min(1)
    .superRefine((ups, ctx) => {
      const seen = new Set<string>();
      for (const u of ups) {
        if (seen.has(u.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate upstream name "${u.name}"`,
          });
        }
        seen.add(u.name);
      }
    }),
  auth: authSchema.default({}),
  tenants: z.array(tenantSchema).default([]),
  rateLimit: rateLimitGlobalSchema.default({}),
  cache: cacheSchema.default({}),
  redis: redisSchema.default({}),
  observability: observabilitySchema.default({}),
});

export type StdioTransportConfig = z.infer<typeof stdioTransportSchema>;
export type HttpTransportConfig = z.infer<typeof httpTransportSchema>;
export type SseTransportConfig = z.infer<typeof sseTransportSchema>;
export type TransportConfig = z.infer<typeof transportSchema>;
export type RetryConfig = z.infer<typeof retrySchema>;
export type CircuitBreakerConfig = z.infer<typeof circuitBreakerSchema>;
export type UpstreamConfig = z.infer<typeof upstreamSchema>;
export type ApiKeyProviderConfig = z.infer<typeof apiKeyProviderSchema>;
export type JwtProviderConfig = z.infer<typeof jwtProviderSchema>;
export type MtlsProviderConfig = z.infer<typeof mtlsProviderSchema>;
export type AuthConfig = z.infer<typeof authSchema>;
export type RbacConfig = z.infer<typeof rbacSchema>;
export type BucketConfig = z.infer<typeof bucketSchema>;
export type TenantRateLimitConfig = z.infer<typeof tenantRateLimitSchema>;
export type TenantConfig = z.infer<typeof tenantSchema>;
export type CacheConfig = z.infer<typeof cacheSchema>;
export type ObservabilityConfig = z.infer<typeof observabilitySchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
export type AdminConfig = z.infer<typeof adminSchema>;
export type RedisConfig = z.infer<typeof redisSchema>;
export type NamespaceConfig = z.infer<typeof namespaceSchema>;
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
