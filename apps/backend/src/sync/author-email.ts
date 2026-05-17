// Extract the email portion of a BB commit's `author.raw` field — the
// git-style `"Display Name <email@domain>"` string. Returns null when:
//
//   - the raw string carries no `<...>` segment at all (just a name, or
//     a malformed entry — BB occasionally returns synthetic-looking
//     blobs without angle brackets);
//   - the angle-bracketed content doesn't look like an email (must
//     contain `@` and at least one `.` in the domain half);
//   - the address is BB's web-merge synthetic (`*@noreply.bitbucket.org`,
//     `noreply@*`) or any `*+noreply@*` GitHub-style mirror that
//     occasionally lands via cross-platform mirrors. These are NOT the
//     contributor's real email — capturing them would poison the column
//     under write-once semantics.
//
// Deliberately tolerant beyond those filters: a single bogus address
// from someone's fresh laptop is still kept (write-once means we set it
// once and stop), and "exotic but parseable" addresses (subdomains,
// pluses, dashes) are accepted as-is. The dashboard treats this field
// as best-effort "git-author email", not verified identity.

const ANGLE_BRACKET_EMAIL = /<\s*([^<>\s]+)\s*>/;

export function parseAuthorEmail(authorRaw: string | null | undefined): string | null {
  if (authorRaw === null || authorRaw === undefined) return null;
  const match = ANGLE_BRACKET_EMAIL.exec(authorRaw);
  if (match === null) return null;
  const candidate = match[1]!.toLowerCase();
  // Shape check — `@` and at least one `.` in the domain half. Rejects
  // `foo@bar` (no TLD) and `@foo.com` (no local part).
  const at = candidate.indexOf('@');
  if (at <= 0 || at === candidate.length - 1) return null;
  const domain = candidate.slice(at + 1);
  if (!domain.includes('.')) return null;
  // Synthetic / noreply filters. BB web-merge commits typically use
  // `<uuid+username>@users.noreply.bitbucket.org` or similar; GitHub-mirrored
  // commits use `*@users.noreply.github.com`. Anything with `noreply` in
  // the local part or in the immediate left-of-tld segment is junk for
  // our purposes.
  if (/^noreply/i.test(candidate)) return null;
  if (/noreply\./i.test(domain)) return null;
  if (/\+noreply@/i.test(candidate)) return null;
  return candidate;
}
