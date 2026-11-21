// Phase 1 techniques: BASE baseline, AUTH negatives, B required fields, A data types.
import { AUTH_RULES } from '../auth/provider.js';
import { OMIT } from '../data/request.js';
import { isPlainObject } from '../util/json.js';
import { pyRegex } from '../util/py.js';
import { Expectation, Generator, Mutation, iterFields } from './base.js';

// [rule suffix, value]; the first two are used at level standard, all at level full
export const BODY_WRONG_TYPES = {
  string: [['INT', 12345], ['OBJECT', { apitest: 1 }], ['BOOL', true], ['NUMBER', 1.5], ['ARRAY', ['apitest']]],
  integer: [['STRING', 'apitest'], ['DECIMAL', 1.5], ['BOOL', true], ['ARRAY', [1]], ['OBJECT', { apitest: 1 }]],
  number: [['STRING', 'apitest'], ['BOOL', true], ['ARRAY', [1]], ['OBJECT', { apitest: 1 }]],
  boolean: [['STRING', 'apitest'], ['INT', 12345], ['ARRAY', [true]], ['OBJECT', { apitest: 1 }]],
  array: [['STRING', 'apitest'], ['OBJECT', { apitest: 1 }], ['INT', 12345], ['BOOL', true]],
  object: [['STRING', 'apitest'], ['ARRAY', []], ['INT', 12345], ['BOOL', true]],
};
// Parameters travel as text: only values that cannot be parsed as the declared type make sense.
export const PARAM_WRONG_TYPES = {
  integer: [['STRING', 'apitest'], ['DECIMAL', '1.5'], ['BOOL', 'true']],
  number: [['STRING', 'apitest'], ['BOOL', 'true']],
  boolean: [['STRING', 'apitest'], ['INT', '12345']],
};
export const OVERFLOW = { int32: [2n ** 31n, -(2n ** 31n) - 1n], int64: [2n ** 63n, -(2n ** 63n) - 1n] };
export const FORMAT_INVALID = {
  email: 'apitest-not-an-email', uuid: 'not-a-uuid', uri: 'not a uri', url: 'not a url', ipv4: '999.999.1', byte: '!!not base64!!',
};

/** int32 overflow values fit in a JS number; int64 ones stay BigInt (sent as exact digits). */
const exact = (b) => (b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b);

export class BaselineGenerator extends Generator {
  static technique = 'BASE';
  static group = 'baseline';

  generate(ctx) {
    const c = this.make(ctx, { rule_id: 'BASELINE', title: 'valid baseline request must succeed', mutation: new Mutation('none'), expectation: new Expectation('accept'), level: 'smoke' });
    return c ? [c] : [];
  }
}

export class AuthGenerator extends Generator {
  static technique = 'AUTH';
  static group = 'auth';

  generate(ctx) {
    if (!ctx.auth.needs) return [];
    const codes = ctx.target.auth.unauth_expect;
    const out = [];
    for (const [ruleId, title] of AUTH_RULES) {
      if (ruleId === 'AUTH-EXPIRED' && !ctx.target.auth.expired_env) continue;
      const header = ctx.target.auth.header;
      const c = this.make(ctx, {
        rule_id: ruleId, title: `${header}: ${title}`, mutation: new Mutation('auth', null, ruleId),
        expectation: new Expectation('auth_reject', codes), level: 'smoke', field_label: `header.${header}`,
      });
      if (c) out.push(c);
    }
    return out;
  }
}

export class RequiredFieldGenerator extends Generator {
  static technique = 'B-required';

  generate(ctx) {
    const out = [];
    const fields = [...iterFields(ctx.op, ctx.baseline, ctx.target)];
    for (const f of fields) {
      if (!f.required) continue;
      const label = f.ref.label;
      const t = f.schema.effective_type;
      const variants = [['REQ-OMIT', OMIT, 'omitted']];
      if (f.is_param) {
        if ((t === null || t === 'string') && f.ref.location !== 'path') variants.push(['REQ-EMPTY', '', 'empty string']);
      } else {
        variants.push(['REQ-NULL', null, 'null']);
        if (t === 'string') variants.push(['REQ-EMPTY', '', 'empty string'], ['REQ-BLANK', '   ', 'whitespace only']);
      }
      for (const [rule, value, what] of variants) {
        out.push(this.make(ctx, {
          rule_id: rule, title: `required ${label} ${what} must be rejected`, mutation: new Mutation('set', f.ref, value),
          expectation: this.reject(ctx), level: 'standard', field_label: label,
        }));
      }
    }
    const positive = this.onlyRequired(ctx, fields);
    if (positive !== null) out.push(positive);
    return out.filter(Boolean);
  }

  /** Positive check: only required fields (and resource-bound fields) sent -> must succeed. */
  onlyRequired(ctx, fields) {
    const tpl = ctx.baseline.copy();
    let removed = 0;
    // deepest first so parents are removed after their children were considered (stable sort, like Python)
    const ordered = [...fields].sort((a, b) => b.ref.path.length - a.ref.path.length);
    for (const f of ordered) {
      if (f.required || ctx.bound(f.ref)) continue;
      if (f.ref.location === 'body' && !parentsPresent(tpl.body, f.ref.path)) continue;
      tpl.set(f.ref, OMIT);
      removed += 1;
    }
    if (removed === 0) return null;
    const parts = { path: tpl.path, query: tpl.query, headers: tpl.headers, body: tpl.body };
    return this.make(ctx, {
      rule_id: 'REQ-ONLY-REQUIRED', title: 'only required fields sent must succeed', mutation: new Mutation('replace', null, parts),
      expectation: new Expectation('accept'), level: 'standard',
    });
  }
}

function parentsPresent(body, path) {
  let node = body;
  for (const part of path.slice(0, -1)) {
    if (Array.isArray(node) ? !(typeof part === 'number' && part < node.length) : !(isPlainObject(node) && part in node)) return false;
    node = node[part];
  }
  return Array.isArray(node) || isPlainObject(node);
}

const swapcase = (s) => [...s].map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join('');

export class DataTypeGenerator extends Generator {
  static technique = 'A-datatype';

  generate(ctx) {
    const out = [];
    for (const f of iterFields(ctx.op, ctx.baseline, ctx.target)) {
      const label = f.ref.label;
      const s = f.schema;
      const t = s.effective_type;
      const table = f.is_param ? PARAM_WRONG_TYPES : BODY_WRONG_TYPES;
      (table[t || ''] || []).forEach(([suffix, value], i) => {
        out.push(this.make(ctx, {
          rule_id: `TYPE-${suffix}`, title: `${label} (${t}) as ${suffix.toLowerCase()} must be rejected`,
          mutation: new Mutation('set', f.ref, value), expectation: this.reject(ctx), level: i < 2 ? 'standard' : 'full', field_label: label,
        }));
      });
      const fmt = (s.format || '').toLowerCase();
      if (t === 'integer' && fmt in OVERFLOW) {
        const [hi, lo] = OVERFLOW[fmt];
        const asText = f.is_param;
        out.push(this.make(ctx, {
          rule_id: `FORMAT-${fmt.toUpperCase()}-OVERFLOW`, title: `${label} ${fmt} overflow must be rejected`,
          mutation: new Mutation('set', f.ref, asText ? String(hi) : exact(hi)), expectation: this.reject(ctx), level: 'standard', field_label: label,
        }));
        out.push(this.make(ctx, {
          rule_id: `FORMAT-${fmt.toUpperCase()}-UNDERFLOW`, title: `${label} ${fmt} underflow must be rejected`,
          mutation: new Mutation('set', f.ref, asText ? String(lo) : exact(lo)), expectation: this.reject(ctx), level: 'full', field_label: label,
        }));
      }
      if (t === 'string' && fmt in FORMAT_INVALID) {
        out.push(this.make(ctx, {
          rule_id: `FORMAT-${fmt.toUpperCase()}`, title: `${label} invalid ${fmt} must be rejected`,
          mutation: new Mutation('set', f.ref, FORMAT_INVALID[fmt]), expectation: this.reject(ctx), level: 'standard', field_label: label,
        }));
      }
      const en = s.enum && s.enum.length ? s.enum : (t === 'array' && s.items !== null && s.items.enum && s.items.enum.length ? s.items.enum : null);
      if (en) {
        const wrap = t === 'array' ? (v) => [v] : (v) => v;
        out.push(this.make(ctx, {
          rule_id: 'ENUM-OUTSIDE', title: `${label} value outside enum must be rejected`,
          mutation: new Mutation('set', f.ref, wrap('APITEST_INVALID')), expectation: this.reject(ctx), level: 'standard', field_label: label,
        }));
        const first = en.find((e) => typeof e === 'string' && swapcase(e) !== e);
        if (first !== undefined && !en.includes(swapcase(first))) {
          out.push(this.make(ctx, {
            rule_id: 'ENUM-CASE', title: `${label} enum value in wrong letter case must be rejected`,
            mutation: new Mutation('set', f.ref, wrap(swapcase(first))), expectation: this.reject(ctx), level: 'standard', field_label: label,
          }));
        }
      }
      const pattern = s.constraints.pattern;
      if (t === 'string' && typeof pattern === 'string') {
        const bad = nonMatching(pattern);
        if (bad !== null) {
          out.push(this.make(ctx, {
            rule_id: 'PATTERN-MISMATCH', title: `${label} not matching pattern ${pattern} must be rejected`,
            mutation: new Mutation('set', f.ref, bad), expectation: this.reject(ctx), level: 'standard', field_label: label,
          }));
        }
      }
    }
    return out.filter(Boolean);
  }
}

function nonMatching(pattern) {
  let rx;
  try {
    rx = pyRegex(pattern);
  } catch {
    return null;
  }
  for (const candidate of ['!apitest!', 'apitest', '0', '~~~~', 'A'.repeat(300)]) if (!rx.test(candidate)) return candidate;
  return null;
}
