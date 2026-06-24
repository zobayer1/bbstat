// Per-repo file-path exclude filter for the BB /diffstat aggregator.
// picomatch globs from `repositories.diff_stats_exclude_patterns`, additive
// per repo (no global defaults). Gitignore-style semantics; both
// `entry.new.path` and `entry.old.path` are checked, either match excludes.
// Empty pattern list → pass-through.

import picomatch from 'picomatch';

export type Matcher = (path: string) => boolean;

export function buildMatcher(patterns: string[]): Matcher {
  if (patterns.length === 0) return () => false;
  // Slashless patterns (`*.png`) get an extra `**/*.png` variant so they
  // match at any depth (gitignore intuition); slashy patterns bind to a path
  // prefix unchanged. We expand rather than use picomatch's `basename: true`
  // because basename rewrites the *input* to its basename before matching,
  // which breaks slashy patterns (`dist/**` vs `dist/main.js` → input becomes
  // `main.js` and won't match).
  const expanded = patterns.flatMap((p) => (p.includes('/') ? [p] : [p, `**/${p}`]));
  // `dot: true` so dot-files match `*` / `**` the gitignore way.
  const match = picomatch(expanded, { dot: true });
  return (path: string) => match(path);
}

// Validates each pattern parses. Returns null on success, `{ pattern, message }`
// on the first failure. Used by the admin PUT endpoint before persisting.
export function validatePatterns(patterns: string[]): { pattern: string; message: string } | null {
  for (const p of patterns) {
    if (typeof p !== 'string' || p.length === 0) {
      return { pattern: String(p), message: 'pattern must be a non-empty string' };
    }
    try {
      // picomatch throws on syntactically-invalid patterns.
      picomatch(p, { dot: true });
    } catch (err) {
      return { pattern: p, message: err instanceof Error ? err.message : String(err) };
    }
  }
  return null;
}
