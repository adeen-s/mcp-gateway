import { GatewayError } from '../types.js';
import type { NamespaceConfig } from '../config/schema.js';

export interface NamespacedName {
  upstream: string;
  name: string;
}

/** `github` + `create_issue` -> `github__create_issue` */
export function namespacedName(upstream: string, name: string, separator: string): string {
  return `${upstream}${separator}${name}`;
}

/**
 * Splits a namespaced name back into upstream + original name.
 * The original name may itself contain the separator, so we match against the
 * known upstream list instead of naively splitting on the first occurrence.
 */
export function parseNamespacedName(
  full: string,
  separator: string,
  upstreamNames: readonly string[]
): NamespacedName | undefined {
  // Prefer the longest matching upstream prefix to disambiguate names like
  // `github` vs `github_enterprise` when the separator is `_`.
  let best: NamespacedName | undefined;
  for (const upstream of upstreamNames) {
    const prefix = upstream + separator;
    if (full.startsWith(prefix) && full.length > prefix.length) {
      if (!best || upstream.length > best.upstream.length) {
        best = { upstream, name: full.slice(prefix.length) };
      }
    }
  }
  return best;
}

export interface CollisionResolution<T> {
  /** Winning entries keyed by namespaced name. */
  entries: Map<string, { upstream: string; value: T }>;
  /** Names that collided (only populated for the `first` policy). */
  dropped: { name: string; upstream: string }[];
}

/**
 * Builds the namespaced registry for a batch of per-upstream items.
 *
 * Because every name is prefixed with its upstream, collisions can only occur
 * when two upstreams produce the same *namespaced* string (e.g. upstream
 * `git` exposing `hub__x` with separator `__` colliding with upstream
 * `git__hub` exposing `x` — or duplicate names within one upstream).
 */
export function buildNamespacedRegistry<T>(
  perUpstream: { upstream: string; items: { name: string; value: T }[] }[],
  cfg: NamespaceConfig
): CollisionResolution<T> {
  const entries = new Map<string, { upstream: string; value: T }>();
  const dropped: { name: string; upstream: string }[] = [];

  for (const { upstream, items } of perUpstream) {
    for (const item of items) {
      const full = namespacedName(upstream, item.name, cfg.separator);
      const existing = entries.get(full);
      if (existing) {
        if (cfg.onCollision === 'error') {
          throw new GatewayError(
            `namespaced name collision: "${full}" provided by both "${existing.upstream}" and "${upstream}"`,
            'COLLISION',
            { name: full, upstreams: [existing.upstream, upstream] }
          );
        }
        dropped.push({ name: full, upstream });
        continue; // first wins
      }
      entries.set(full, { upstream, value: item.value });
    }
  }
  return { entries, dropped };
}
