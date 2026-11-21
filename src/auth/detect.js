// Decide per operation whether it needs the credential header.
//
// Order: config overrides > header parameter with the configured name (case-insensitive)
// > security requirement whose scheme is mapped to that header (ignored schemes skipped).
import { fnmatch, sorted } from '../util/py.js';

export class AuthDecision {
  constructor(needs, reason) {
    this.needs = needs;
    this.reason = reason;
    Object.freeze(this);
  }
}

function matches(op, patterns) {
  return (patterns || []).some((pat) => fnmatch(op.operation_id, pat) || fnmatch(op.key, pat) || fnmatch(op.path, pat));
}

export function detectAuth(op, auth) {
  if (!auth || !auth.header) return new AuthDecision(false, 'no auth configured for target');
  const header = auth.header.toLowerCase();
  if (matches(op, auth.auth_required)) return new AuthDecision(true, 'config override: auth_required');
  if (matches(op, auth.auth_not_required)) return new AuthDecision(false, 'config override: auth_not_required');
  for (const p of op.parameters) {
    if (p.location === 'header' && p.name.toLowerCase() === header) return new AuthDecision(true, `header param ${p.name} declared`);
  }
  const mapped = new Set(Object.entries(auth.scheme_map || {}).filter(([, h]) => String(h).toLowerCase() === header).map(([s]) => s));
  const ignored = new Set(auth.ignored_schemes || []);
  let onlyIgnored = false;
  for (const alternative of op.security) {
    const names = new Set(alternative);
    const hit = sorted([...names].filter((n) => mapped.has(n) && !ignored.has(n)));
    if (hit.length) return new AuthDecision(true, `security scheme ${hit[0]} → header ${auth.header}`);
    if (names.size && [...names].every((n) => ignored.has(n))) onlyIgnored = true;
  }
  if (onlyIgnored) return new AuthDecision(false, 'only ignored security schemes (' + sorted([...ignored]).join(', ') + ')');
  if (op.security.length) return new AuthDecision(false, 'security schemes not mapped to the credential header');
  return new AuthDecision(false, 'no auth declared');
}

/** The auth header is excluded from every mutation technique except the AUTH group. */
export function isAuthParam(name, location, auth) {
  return Boolean(auth && auth.header && location === 'header' && name.toLowerCase() === auth.header.toLowerCase());
}
