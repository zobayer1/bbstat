/* eslint-disable no-console -- one-off CLI utility; console output is the deliverable */

// One-off duplicate-account finder. Scores all `users` pairs on name
// token-overlap / edit distance / shared-or-similar email local-part,
// clusters high-scoring pairs (union-find), and prints ranked candidate
// groups for an operator to merge via /api/admin/people. READ-ONLY.
//
//   DATABASE_URL=postgres://… pnpm --filter @bbstat/backend run find:duplicates
//   (or `make find-duplicates`).
// Optional first arg overrides the minimum score (0–1); higher = tighter,
// lower = more recall. Default 0.55.

import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';

const DEFAULT_MIN_SCORE = 0.55;

interface UserRec {
  id: number;
  personId: number | null;
  displayName: string;
  username: string | null;
  email: string | null;
  nameTokens: string[]; // normalized, deduped, sorted
  emailNorm: string | null;
  emailLocal: string | null;
  emailLocalTokens: string[];
}

// `noise` holds the tokens to strip — honorifics and naming-convention
// prefixes that carry no identifying signal. Configured per deployment via
// NAME_NOISE_TOKENS (see config.ts).
function normalizeName(raw: string, noise: ReadonlySet<string>): string[] {
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 1 && !noise.has(t));
  return Array.from(new Set(tokens)).sort();
}

function normalizeEmail(raw: string): { norm: string; local: string; localTokens: string[] } | null {
  const s = raw.toLowerCase().trim();
  const at = s.indexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  const domain = s.slice(at + 1);
  // Strip +tags everywhere; collapse gmail's dot-insensitivity.
  let local = s.slice(0, at).split('+')[0] ?? '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replace(/\./g, '');
  const localTokens = local.split(/[._+-]/).filter((t) => t.length >= 3);
  return { norm: `${local}@${domain}`, local, localTokens };
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? 0;
}

function ratio(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 0 : 1 - levenshtein(a, b) / max;
}

// Weighted, typo-tolerant token-set similarity. Tokens match when equal or
// edit-ratio ≥ 0.85 (catches manirul/monirul while keeping shahidul/shafiul
// apart). IDF weighting makes a shared common surname (Islam, Hossain…) barely
// move the score while a distinctive given name dominates — this stops a whole
// org's worth of "<x> Islam" rows from collapsing into one cluster.
function weightedTokenSim(a: string[], b: string[], weight: (t: string) => number): number {
  if (a.length === 0 || b.length === 0) return 0;
  const usedB = new Set<number>();
  let interW = 0;
  for (const ta of a) {
    let bestJ = -1;
    let bestR = 0;
    for (let j = 0; j < b.length; j++) {
      if (usedB.has(j)) continue;
      const tb = b[j];
      if (tb === undefined) continue;
      const r = ta === tb ? 1 : ratio(ta, tb);
      if (r >= 0.85 && r > bestR) {
        bestR = r;
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      const tb = b[bestJ];
      if (tb !== undefined) {
        usedB.add(bestJ);
        interW += Math.min(weight(ta), weight(tb)) * bestR;
      }
    }
  }
  let unionW = 0;
  for (const t of a) unionW += weight(t);
  for (let j = 0; j < b.length; j++) {
    const t = b[j];
    if (t !== undefined && !usedB.has(j)) unionW += weight(t);
  }
  return unionW === 0 ? 0 : interW / unionW;
}

interface PairScore {
  score: number;
  signals: string[];
}

interface ScoreCtx {
  // IDF weight of a name token (rare → high, common surname → low).
  weight: (t: string) => number;
  // A token distinctive enough that its appearance in the other account's
  // email local-part is a real signal (rare given names, not surnames).
  distinctive: (t: string) => boolean;
}

function scorePair(a: UserRec, b: UserRec, ctx: ScoreCtx): PairScore {
  const signals: string[] = [];

  // --- Name (IDF-weighted, typo-tolerant) ---
  const nameScore = weightedTokenSim(a.nameTokens, b.nameTokens, ctx.weight);
  if (nameScore >= 0.99) signals.push('name-exact');
  else if (nameScore >= 0.5) signals.push(`name~${nameScore.toFixed(2)}`);

  // --- Email ---
  let emailScore = 0;
  let localScore = 0;
  if (a.emailNorm !== null && b.emailNorm !== null) {
    if (a.emailNorm === b.emailNorm) {
      emailScore = 1;
      signals.push('email-exact');
    } else if (a.emailLocal !== null && a.emailLocal === b.emailLocal) {
      emailScore = 0.92;
      signals.push('email-local-exact');
    } else {
      // Weighted so a shared common surname in the local-part (…@…/.islam)
      // doesn't read as a match — only distinctive local tokens do.
      localScore = weightedTokenSim(a.emailLocalTokens, b.emailLocalTokens, ctx.weight);
      if (localScore >= 0.6) signals.push(`email-local~${localScore.toFixed(2)}`);
    }
  }

  // --- Cross: a *distinctive* name token reappears in the other's email
  // local-part (given-name "shahidul" in shahidul.islam@…). Surnames excluded
  // via `distinctive`, so the common-token chains don't form. ---
  const crossHit = (names: string[], localTokens: string[]): boolean =>
    names.some((t) => ctx.distinctive(t) && localTokens.some((lt) => lt === t || ratio(t, lt) >= 0.9));
  const cross = crossHit(a.nameTokens, b.emailLocalTokens) || crossHit(b.nameTokens, a.emailLocalTokens);
  if (cross) signals.push('name-in-email');

  let score = Math.max(
    emailScore === 1 ? 1 : 0, // same address → almost certainly one human
    emailScore >= 0.92 ? 0.92 : 0, // same local-part, different domain (work vs personal)
    nameScore, // IDF-weighted name overlap (1.0 == identical distinctive name)
    0.65 * nameScore + 0.35 * localScore, // blended name + email-local
  );
  if (cross) score = Math.min(1, score + 0.15);

  return { score, signals };
}

function main(): void {
  const argScore = Number(process.argv[2]);
  const minScore = Number.isFinite(argScore) && argScore > 0 && argScore <= 1 ? argScore : DEFAULT_MIN_SCORE;

  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  const nameNoise = new Set(config.NAME_NOISE_TOKENS);

  void (async () => {
    const rows = await db
      .select({
        id: users.id,
        personId: users.personId,
        displayName: users.displayName,
        username: users.username,
        email: users.email,
      })
      .from(users);

    const recs: UserRec[] = rows.map((r) => {
      const e = r.email !== null ? normalizeEmail(r.email) : null;
      return {
        id: r.id,
        personId: r.personId,
        displayName: r.displayName ?? '',
        username: r.username,
        email: r.email,
        nameTokens: normalizeName(r.displayName ?? '', nameNoise),
        emailNorm: e?.norm ?? null,
        emailLocal: e?.local ?? null,
        emailLocalTokens: e?.localTokens ?? [],
      };
    });

    // IDF over name tokens across the whole roster. A token shared by many
    // people (a common surname) is near-worthless as a match signal; a rare
    // given name is strong. Tokens never seen in any name (e.g. an opaque
    // email handle) default to df 0.5 → treated as distinctive.
    const userCount = recs.length;
    const nameDf = new Map<string, number>();
    for (const r of recs) for (const t of r.nameTokens) nameDf.set(t, (nameDf.get(t) ?? 0) + 1);
    const ctx: ScoreCtx = {
      weight: (t) => Math.log(1 + userCount / (nameDf.get(t) ?? 0.5)),
      distinctive: (t) => t.length >= 4 && (nameDf.get(t) ?? 0) <= 3,
    };

    interface Edge {
      a: number;
      b: number;
      score: number;
      signals: string[];
    }
    const edges: Edge[] = [];
    for (let i = 0; i < recs.length; i++) {
      const a = recs[i];
      if (a === undefined) continue;
      for (let j = i + 1; j < recs.length; j++) {
        const b = recs[j];
        if (b === undefined) continue;
        // Skip aliases already merged into the same person.
        if (a.personId !== null && a.personId === b.personId) continue;
        const { score, signals } = scorePair(a, b, ctx);
        if (score >= minScore) edges.push({ a: a.id, b: b.id, score, signals });
      }
    }
    edges.sort((x, y) => y.score - x.score);

    // Union-find: collapse transitively-linked pairs into clusters.
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      const p = parent.get(x) ?? x;
      if (p === x) return x;
      const root = find(p);
      parent.set(x, root);
      return root;
    };
    const union = (x: number, y: number): void => {
      const px = find(x);
      const py = find(y);
      if (px !== py) parent.set(px, py);
    };
    for (const e of edges) union(e.a, e.b);

    const byId = new Map(recs.map((r) => [r.id, r] as const));
    const clusters = new Map<number, { members: Set<number>; edges: Edge[]; best: number }>();
    for (const e of edges) {
      const root = find(e.a);
      let c = clusters.get(root);
      if (c === undefined) {
        c = { members: new Set(), edges: [], best: 0 };
        clusters.set(root, c);
      }
      c.members.add(e.a);
      c.members.add(e.b);
      c.edges.push(e);
      c.best = Math.max(c.best, e.score);
    }
    const ordered = Array.from(clusters.values()).sort((a, b) => b.best - a.best);

    console.log(
      `Scanned ${recs.length} users · ${edges.length} candidate pairs ≥ ${minScore} · ${ordered.length} clusters\n`,
    );
    let n = 0;
    for (const c of ordered) {
      n += 1;
      console.log(`── Candidate ${n}  (best ${c.best.toFixed(2)}) ──`);
      for (const id of c.members) {
        const u = byId.get(id);
        if (u === undefined) continue;
        const tag = u.personId !== null ? `person#${u.personId}` : 'unattached';
        const handle = u.username !== null ? `  @${u.username}` : '';
        console.log(`   #${u.id}  [${tag}]  "${u.displayName}"  <${u.email ?? '—'}>${handle}`);
      }
      for (const e of c.edges) {
        console.log(`     · #${e.a} ↔ #${e.b}  ${e.score.toFixed(2)}  [${e.signals.join(', ')}]`);
      }
      console.log('');
    }
    if (ordered.length === 0) {
      console.log(`No candidate pairs ≥ ${minScore}. Re-run with a lower score, e.g. \`… 0.45\`.`);
    } else {
      console.log(`Review each cluster. A [person#N] tag means that account is already merged —`);
      console.log(`attach the others to it (POST /api/admin/people/N/attach) rather than creating`);
      console.log(`a new person. See docs/people.md for the merge recipe.`);
    }
    process.exit(0);
  })().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

main();
