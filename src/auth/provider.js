// AuthProvider interface. The tool never generates, refreshes or stores credentials: a provider only
// places a credential the user supplied. New providers (e.g. single-use CAS service tickets) implement
// the same interface without changes elsewhere.
import { mask } from './masking.js';

// AUTH negative rules [rule_id, title]. EXPIRED only runs when an expired credential is supplied.
export const AUTH_RULES = Object.freeze([
  ['AUTH-MISSING', 'credential header missing must be rejected'],
  ['AUTH-EMPTY', 'empty credential must be rejected'],
  ['AUTH-MALFORMED', 'malformed credential must be rejected'],
  ['AUTH-WRONG-PREFIX', 'credential with wrong prefix must be rejected'],
  ['AUTH-EXPIRED', 'expired credential must be rejected'],
]);
export const MALFORMED_VALUE = 'apitest!malformed#credential';

export class AuthVariant {
  constructor(rule_id, headers) {
    this.rule_id = rule_id;
    this.headers = headers; // null -> header omitted
    Object.freeze(this);
  }
}

/** Interface: hasCredential(), headers(), variant(ruleId), secrets(), masked(). */
export class AuthProvider {
  name = 'abstract';
  header_name = null;

  hasCredential() {
    throw new Error('not implemented');
  }

  /** Headers for a normal request of an operation that needs the credential. */
  headers() {
    throw new Error('not implemented');
  }

  /** Headers for an AUTH negative test; null if the variant cannot run (e.g. no expired value). */
  variant(_ruleId) { // eslint-disable-line no-unused-vars
    throw new Error('not implemented');
  }

  secrets() {
    return [];
  }

  masked() {
    return '';
  }
}

export class NoAuth extends AuthProvider {
  name = 'none';

  hasCredential() {
    return false;
  }

  headers() {
    return {};
  }

  variant(ruleId) {
    return ruleId === 'AUTH-MISSING' ? new AuthVariant(ruleId, null) : null;
  }
}

export class StaticHeaderAuth extends AuthProvider {
  name = 'static-header';

  constructor(headerName, value, prefix = '', expiredValue = null) {
    super();
    this.header_name = headerName;
    this.value = value || null;
    this.prefix = prefix || '';
    this.expired_value = expiredValue || null;
  }

  hasCredential() {
    return Boolean(this.value);
  }

  headers() {
    return this.value ? { [this.header_name]: this.prefix + this.value } : {};
  }

  variant(ruleId) {
    const h = this.header_name;
    if (ruleId === 'AUTH-MISSING') return new AuthVariant(ruleId, null);
    if (!this.value) return null;
    if (ruleId === 'AUTH-EMPTY') return new AuthVariant(ruleId, { [h]: '' });
    if (ruleId === 'AUTH-MALFORMED') return new AuthVariant(ruleId, { [h]: this.prefix + MALFORMED_VALUE });
    if (ruleId === 'AUTH-WRONG-PREFIX') return new AuthVariant(ruleId, { [h]: this.prefix ? this.value : 'Bearer ' + this.value });
    if (ruleId === 'AUTH-EXPIRED') return this.expired_value ? new AuthVariant(ruleId, { [h]: this.prefix + this.expired_value }) : null;
    return null;
  }

  secrets() {
    return [this.value, this.expired_value].filter(Boolean);
  }

  masked() {
    return mask(this.value);
  }

  /** Used on resume after the user supplied a fresh credential. */
  replaceCredential(value) {
    this.value = value;
  }
}

export function buildProvider(header, value, prefix = '', expiredValue = null) {
  if (!header) return new NoAuth();
  return new StaticHeaderAuth(header, value, prefix, expiredValue);
}
