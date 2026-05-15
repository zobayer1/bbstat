// Per-repo file-path filter for the BB /diffstat aggregator. Patterns
// are picomatch globs sourced from `repositories.diff_stats_exclude_patterns`
// — they're additive per repo (no global defaults), so the operator's
// canonical "what counts as a code change" view lives entirely in that
// column. Empty pattern list → pass-through (every file contributes).
//
// Matching semantics: gitignore-style. `*.png` matches at any depth,
// `dist/**` matches everything under dist at the repo root. Both
// `entry.new.path` (typical) and `entry.old.path` (deletes, renames'
// source path) are checked; an entry matching either is excluded.

import picomatch from 'picomatch';

export type Matcher = (path: string) => boolean;

// True iff `path` matches any of the configured globs. Empty matcher
// (no patterns) returns false for every input.
export function buildMatcher(patterns: string[]): Matcher {
  if (patterns.length === 0) return () => false;
  // Slashless patterns (e.g. `*.png`, `package-lock.json`) get an
  // auto-generated `**/*.png` variant so they match at any depth — the
  // gitignore-style intuition operators expect. Patterns with slashes
  // (e.g. `dist/**`, `Assets/**/*.meta`) are passed through unchanged
  // and bind to a path prefix.
  //
  // `basename: true` is deliberately NOT used: picomatch's basename
  // option rewrites the *input string* to its basename before matching,
  // which breaks slashy patterns (`dist/**` against `dist/main.js`
  // wouldn't match because the input becomes `main.js`). Expansion
  // gets the same UX without the side effect.
  const expanded = patterns.flatMap((p) => (p.includes('/') ? [p] : [p, `**/${p}`]));
  // `dot: true` so dot-files (`.env`, `.github/workflows/*`) match
  // `*` / `**` patterns the way gitignore does.
  const match = picomatch(expanded, { dot: true });
  return (path: string) => match(path);
}

// Validates each pattern is a parseable picomatch glob. Returns null on
// success, an `{ pattern, message }` on the first failure. Used by the
// admin PUT endpoint before persisting the column.
export function validatePatterns(patterns: string[]): { pattern: string; message: string } | null {
  for (const p of patterns) {
    if (typeof p !== 'string' || p.length === 0) {
      return { pattern: String(p), message: 'pattern must be a non-empty string' };
    }
    try {
      // picomatch throws on syntactically-invalid patterns; build it as
      // a one-shot to surface any parse error here.
      picomatch(p, { dot: true });
    } catch (err) {
      return { pattern: p, message: err instanceof Error ? err.message : String(err) };
    }
  }
  return null;
}
