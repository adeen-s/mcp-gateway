/**
 * Minimal glob matching for tool / resource patterns.
 *
 * Supported syntax:
 *   `*`  matches any run of characters (including none)
 *   `?`  matches exactly one character
 *
 * Everything else is literal. This is intentionally simpler than full
 * minimatch: patterns apply to flat tool names (`github__create_*`) and
 * resource URIs (`file:///srv/docs/*`), not nested path segments.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}

export class GlobList {
  private readonly regexes: RegExp[];

  constructor(readonly patterns: readonly string[]) {
    this.regexes = patterns.map(globToRegExp);
  }

  matches(value: string): boolean {
    return this.regexes.some((r) => r.test(value));
  }
}
