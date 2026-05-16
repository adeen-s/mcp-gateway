import { describe, expect, it } from 'vitest';
import { tenantSchema } from '../config/schema.js';
import { globToRegExp, GlobList } from './glob.js';
import { RbacEngine } from './rbac.js';

const tenant = (id: string, rbac: Record<string, unknown>) =>
  tenantSchema.parse({ id, rbac });

describe('globToRegExp', () => {
  it('matches literal names exactly', () => {
    expect(globToRegExp('github__create_issue').test('github__create_issue')).toBe(true);
    expect(globToRegExp('github__create_issue').test('github__create_issues')).toBe(false);
  });

  it('supports * and ? wildcards', () => {
    expect(globToRegExp('github__*').test('github__list_repos')).toBe(true);
    expect(globToRegExp('github__*').test('jira__list_issues')).toBe(false);
    expect(globToRegExp('env_?').test('env_1')).toBe(true);
    expect(globToRegExp('env_?').test('env_12')).toBe(false);
  });

  it('escapes regex metacharacters in literals', () => {
    expect(globToRegExp('file:///srv/docs/*').test('file:///srv/docs/readme.md')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});

describe('RbacEngine', () => {
  it('rejects tenants that are not declared in config', () => {
    const engine = new RbacEngine([tenant('acme', {})]);
    expect(engine.checkTool('ghost', 'anything')).toEqual({
      allowed: false,
      reason: 'unknown-tenant',
    });
  });

  it('defaults to allow when no allow-list is configured', () => {
    const engine = new RbacEngine([tenant('acme', {})]);
    expect(engine.checkTool('acme', 'github__create_issue').allowed).toBe(true);
    expect(engine.checkTool('acme', 'github__create_issue').reason).toBe('default-allow');
  });

  it('deny rules win over allow rules', () => {
    const engine = new RbacEngine([
      tenant('acme', { allowTools: ['github__*'], denyTools: ['github__delete_*'] }),
    ]);
    expect(engine.checkTool('acme', 'github__create_issue').allowed).toBe(true);
    expect(engine.checkTool('acme', 'github__delete_repo')).toEqual({
      allowed: false,
      reason: 'deny-rule',
    });
  });

  it('an allow-list turns unmatched tools into denials', () => {
    const engine = new RbacEngine([tenant('acme', { allowTools: ['search__*'] })]);
    expect(engine.checkTool('acme', 'search__web').allowed).toBe(true);
    expect(engine.checkTool('acme', 'github__create_issue')).toEqual({
      allowed: false,
      reason: 'no-allow-match',
    });
  });

  it('applies independent policies for resources', () => {
    const engine = new RbacEngine([
      tenant('acme', {
        allowResources: ['file:///srv/public/*'],
        denyResources: ['file:///srv/public/secrets/*'],
      }),
    ]);
    expect(engine.checkResource('acme', 'file:///srv/public/readme.md').allowed).toBe(true);
    expect(engine.checkResource('acme', 'file:///srv/public/secrets/key.pem').allowed).toBe(false);
    expect(engine.checkResource('acme', 'file:///srv/private/x').allowed).toBe(false);
  });

  it('filters tool and resource listings down to visible entries', () => {
    const engine = new RbacEngine([tenant('acme', { allowTools: ['echo__*'] })]);
    const tools = [{ name: 'echo__say' }, { name: 'github__create_issue' }];
    expect(engine.filterTools('acme', tools)).toEqual([{ name: 'echo__say' }]);
    expect(engine.filterTools('ghost', tools)).toEqual([]);
  });

  it('replace() swaps policies atomically for config reload', () => {
    const engine = new RbacEngine([tenant('acme', {})]);
    engine.replace([tenant('beta', {})]);
    expect(engine.knowsTenant('acme')).toBe(false);
    expect(engine.knowsTenant('beta')).toBe(true);
  });
});

describe('GlobList', () => {
  it('matches if any pattern matches', () => {
    const list = new GlobList(['a__*', 'b__exact']);
    expect(list.matches('a__anything')).toBe(true);
    expect(list.matches('b__exact')).toBe(true);
    expect(list.matches('c__nope')).toBe(false);
  });
});
