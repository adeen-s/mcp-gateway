import { trace, type Tracer } from '@opentelemetry/api';
import type { ObservabilityConfig } from '../config/schema.js';
import type { Logger } from './logger.js';

export const TRACER_NAME = 'mcp-gateway';

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export interface TracingHandle {
  shutdown(): Promise<void>;
}

/**
 * Boots the OpenTelemetry node SDK with an OTLP/HTTP trace exporter.
 * Loaded lazily so that deployments without tracing pay no startup cost.
 */
export async function initTracing(
  config: ObservabilityConfig['tracing'],
  logger: Logger
): Promise<TracingHandle | undefined> {
  if (!config.enabled) return undefined;

  const [{ NodeSDK }, { OTLPTraceExporter }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
  ]);

  const sdk = new NodeSDK({
    serviceName: config.serviceName,
    traceExporter: new OTLPTraceExporter(
      config.otlpEndpoint ? { url: config.otlpEndpoint } : {}
    ),
  });
  sdk.start();
  logger.info(
    { serviceName: config.serviceName, otlpEndpoint: config.otlpEndpoint ?? 'default' },
    'opentelemetry tracing started'
  );
  return {
    shutdown: async () => {
      await sdk.shutdown();
    },
  };
}
