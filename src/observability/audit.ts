import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import type { ObservabilityConfig } from '../config/schema.js';
import type { TenantIdentity } from '../types.js';

export interface AuditEvent {
  ts: string;
  event:
    | 'tool_call'
    | 'resource_read'
    | 'list_tools'
    | 'list_resources'
    | 'auth_failure'
    | 'rbac_denied'
    | 'rate_limited'
    | 'session_open'
    | 'session_close';
  tenant?: string;
  authMethod?: TenantIdentity['method'];
  subject?: string;
  sessionId?: string;
  tool?: string;
  resource?: string;
  upstream?: string;
  status?: 'ok' | 'error' | 'denied';
  durationMs?: number;
  cached?: boolean;
  error?: string;
}

export interface AuditSink {
  write(line: string): void;
  close(): Promise<void>;
}

class StdoutSink implements AuditSink {
  write(line: string): void {
    process.stdout.write(line + '\n');
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FileSink implements AuditSink {
  private stream: WriteStream;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: 'a' });
  }
  write(line: string): void {
    this.stream.write(line + '\n');
  }
  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }
}

/**
 * Append-only JSONL audit trail of every security-relevant decision the
 * gateway makes. Argument payloads are deliberately excluded — they may
 * contain secrets; correlate with traces when payload context is needed.
 */
export class AuditLogger {
  private readonly sink: AuditSink | undefined;

  constructor(config: ObservabilityConfig['audit'], sinkOverride?: AuditSink) {
    if (sinkOverride) {
      this.sink = sinkOverride;
    } else if (!config.enabled) {
      this.sink = undefined;
    } else if (config.sink === 'file') {
      this.sink = new FileSink(config.path as string);
    } else {
      this.sink = new StdoutSink();
    }
  }

  record(event: Omit<AuditEvent, 'ts'>): void {
    if (!this.sink) return;
    const full: AuditEvent = { ts: new Date().toISOString(), ...event };
    this.sink.write(JSON.stringify(full));
  }

  async close(): Promise<void> {
    await this.sink?.close();
  }
}
