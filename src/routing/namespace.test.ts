import { describe, expect, it } from 'vitest';
import { GatewayError } from '../types.js';
import { buildNamespacedRegistry, namespacedName, parseNamespacedName } from './namespace.js';

describe('namespacedName', () => {
  it('joins upstream and tool with the separator', () => {
    expect(namespacedName('github', 'create_issue', '__')).toBe('github__create_issue');
    expect(namespacedName('fs', 'read', ':')).toBe('fs:read');
  });
});

describe('parseNamespacedName', () => {
  const upstreams = ['github', 'github_enterprise', 'slack'];

  it('splits a namespaced name back into its parts', () => {
    expect(parseNamespacedName('github__create_issue', '__', upstreams)).toEqual({
      upstream: 'github',
      name: 'create_issue',
    });
  });

  it('prefers the longest matching upstream prefix', () => {
    // With separator `_`, both `github` and `github_enterprise` are prefixes.
    expect(parseNamespacedName('github_enterprise_list', '_', upstreams)).toEqual({
      upstream: 'github_enterprise',
      name: 'list',
    });
  });

  it('keeps separators inside the original tool name intact', () => {
    expect(parseNamespacedName('slack__post__message', '__', upstreams)).toEqual({
      upstream: 'slack',
      name: 'post__message',
    });
  });

  it('returns undefined for unknown namespaces or empty names', () => {
    expect(parseNamespacedName('jira__create', '__', upstreams)).toBeUndefined();
    expect(parseNamespacedName('github__', '__', upstreams)).toBeUndefined();
    expect(parseNamespacedName('github', '__', upstreams)).toBeUndefined();
  });
});

describe('buildNamespacedRegistry', () => {
  const cfgError = { separator: '__', onCollision: 'error' as const };
  const cfgFirst = { separator: '__', onCollision: 'first' as const };

  it('namespaces items from multiple upstreams', () => {
    const { entries } = buildNamespacedRegistry(
      [
        { upstream: 'a', items: [{ name: 'x', value: 1 }] },
        { upstream: 'b', items: [{ name: 'x', value: 2 }] },
      ],
      cfgError
    );
    expect([...entries.keys()].sort()).toEqual(['a__x', 'b__x']);
  });

  it('throws on collision with the error policy', () => {
    expect(() =>
      buildNamespacedRegistry(
        [{ upstream: 'a', items: [{ name: 'x', value: 1 }, { name: 'x', value: 2 }] }],
        cfgError
      )
    ).toThrow(GatewayError);
  });

  it('first wins with the first policy, and drops are reported', () => {
    const { entries, dropped } = buildNamespacedRegistry(
      [{ upstream: 'a', items: [{ name: 'x', value: 1 }, { name: 'x', value: 2 }] }],
      cfgFirst
    );
    expect(entries.get('a__x')?.value).toBe(1);
    expect(dropped).toEqual([{ name: 'a__x', upstream: 'a' }]);
  });

  it('detects cross-upstream collisions through the separator', () => {
    // upstream `git` + tool `hub__x`  collides with  upstream `git__hub` + tool `x`
    expect(() =>
      buildNamespacedRegistry(
        [
          { upstream: 'git', items: [{ name: 'hub__x', value: 1 }] },
          { upstream: 'git__hub', items: [{ name: 'x', value: 2 }] },
        ],
        cfgError
      )
    ).toThrow(/collision/);
  });
});
