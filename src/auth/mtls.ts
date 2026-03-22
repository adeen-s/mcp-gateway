import type { MtlsProviderConfig } from '../config/schema.js';
import type { TenantIdentity } from '../types.js';
import type { AuthProvider, AuthRequestContext } from './provider.js';

function normalizeFingerprint(fp: string): string {
  return fp.replace(/:/g, '').toLowerCase();
}

/**
 * Mutual-TLS client certificate authentication.
 *
 * The TLS layer (see server.ts) verifies the chain against the configured CA;
 * this provider only maps an already-verified certificate to a tenant via
 * SHA-256 fingerprint (preferred) or subject CN.
 */
export class MtlsAuthProvider implements AuthProvider {
  readonly name = 'mtls';
  private readonly byFingerprint = new Map<string, string>();
  private readonly byCN = new Map<string, string>();

  constructor(config: MtlsProviderConfig) {
    for (const entry of config.certs) {
      if (entry.fingerprint256) {
        this.byFingerprint.set(normalizeFingerprint(entry.fingerprint256), entry.tenant);
      }
      if (entry.subjectCN) {
        this.byCN.set(entry.subjectCN, entry.tenant);
      }
    }
  }

  authenticate(ctx: AuthRequestContext): Promise<TenantIdentity | null> {
    const cert = ctx.peerCertificate;
    if (!cert || Object.keys(cert).length === 0) return Promise.resolve(null);

    // Node's type for subject fields is string | string[]; normalize.
    const rawCN = cert.subject?.CN as string | string[] | undefined;
    const cn = Array.isArray(rawCN) ? rawCN[0] : rawCN;

    if (cert.fingerprint256) {
      const tenant = this.byFingerprint.get(normalizeFingerprint(cert.fingerprint256));
      if (tenant) {
        return Promise.resolve({
          tenantId: tenant,
          method: 'mtls',
          subject: `cert:${cn ?? cert.fingerprint256}`,
        });
      }
    }
    if (cn) {
      const tenant = this.byCN.get(cn);
      if (tenant) {
        return Promise.resolve({
          tenantId: tenant,
          method: 'mtls',
          subject: `cert:${cn}`,
        });
      }
    }
    return Promise.resolve(null);
  }
}
