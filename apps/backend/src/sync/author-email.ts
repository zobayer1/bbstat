// Extract the email portion of a BB commit's `author.raw` field — the
// git-style `"Display Name <email@domain>"` string. Returns null for a
// missing/malformed `<...>` segment, non-email content, or BB/GitHub
// noreply synthetics — capturing those would poison the column under
// write-once semantics.
//
// Otherwise deliberately tolerant: a bogus address from someone's fresh
// laptop is still kept (write-once), and exotic-but-parseable addresses
// are accepted. The dashboard treats this as best-effort "git-author
// email", not verified identity.

const ANGLE_BRACKET_EMAIL = /<\s*([^<>\s]+)\s*>/;

export function parseAuthorEmail(authorRaw: string | null | undefined): string | null {
  if (authorRaw === null || authorRaw === undefined) return null;
  const match = ANGLE_BRACKET_EMAIL.exec(authorRaw);
  if (match === null) return null;
  const candidate = match[1]!.toLowerCase();
  // Shape check — rejects `foo@bar` (no TLD) and `@foo.com` (no local part).
  const at = candidate.indexOf('@');
  if (at <= 0 || at === candidate.length - 1) return null;
  const domain = candidate.slice(at + 1);
  if (!domain.includes('.')) return null;
  // Synthetic / noreply filters: BB web-merge and GitHub-mirrored
  // commits use *@users.noreply.{bitbucket,github}.org addresses.
  if (/^noreply/i.test(candidate)) return null;
  if (/noreply\./i.test(domain)) return null;
  if (/\+noreply@/i.test(candidate)) return null;
  return candidate;
}

// Extract the display-name portion of `author.raw` — everything before
// `<email>`, trimmed. Snapshot value for `commits.author_display_name`
// and the fallback for an auto-created user's `display_name` when BB
// omits `author.user.display_name`. Returns null when no usable name
// can be parsed (raw is just an email, or empty).
export function parseAuthorDisplayName(authorRaw: string | null | undefined): string | null {
  if (authorRaw === null || authorRaw === undefined) return null;
  const angleIdx = authorRaw.indexOf('<');
  // No angle bracket — whole string could be a plain name (synthetic
  // BB blobs). Trim and return if non-empty.
  if (angleIdx === -1) {
    const trimmed = authorRaw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const name = authorRaw.slice(0, angleIdx).trim();
  return name.length > 0 ? name : null;
}
