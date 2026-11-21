// C: boundary values from spec constraints; generic limits where the spec has none.
//
// With a constraint (level standard):
//   minimum/maximum (+ exclusive)  min-1, min, min+1, max-1, max, max+1   outside -> reject, inside -> accept
//   multipleOf m                   k*m + m/2                               reject
//   minLength/maxLength            len-1, len, len+1                       outside -> reject, inside -> accept
//   minItems/maxItems              n-1, n, n+1 items                       outside -> reject, inside -> accept
//   uniqueItems                    two identical items                     reject
// Without a constraint (level full): generic limits (0, -1, int32/int64 limits, empty, very long,
// empty/huge arrays) with expectation "no 5xx", plus ONE documentation finding per field:
// "constraint missing in spec" (a documentation finding, not a failure).
import { normInt } from '../util/json.js';
import { deepCopy, roundHalfEven } from '../util/py.js';
import { Expectation, Generator, Mutation, iterFields } from './base.js';

export const LONG = 10000;
const INT32_MAX = 2 ** 31 - 1;
const SKIP_STRING_FORMATS = new Set(['date-time', 'date', 'email', 'uuid', 'uri', 'url', 'byte', 'binary', 'ipv4', 'ipv6']);
const isNumber = (v) => (typeof v === 'number' || typeof v === 'bigint');

/** value + delta as int (truncated) or as a float rounded to 6 digits. BigInt bounds stay exact. */
function num(value, delta, integer) {
  if (typeof value === 'bigint') return integer ? normInt(value + BigInt(Math.trunc(delta))) : roundHalfEven(Number(value) + delta, 6);
  const v = value + delta;
  return integer ? Math.trunc(v) : roundHalfEven(v, 6);
}

export class BoundaryGenerator extends Generator {
  static technique = 'C-boundary';

  generate(ctx) {
    const out = [];
    for (const f of iterFields(ctx.op, ctx.baseline, ctx.target)) {
      const s = f.schema;
      if ((s.enum && s.enum.length) || s.read_only) continue;
      const t = s.effective_type;
      if (t === 'integer' || t === 'number') out.push(...this.numeric(ctx, f));
      else if (t === 'string' && !SKIP_STRING_FORMATS.has(s.format || '')) out.push(...this.string(ctx, f));
      else if (t === 'array' && Array.isArray(f.value)) out.push(...this.array(ctx, f));
    }
    return out.filter(Boolean);
  }

  // helpers -----------------------------------------------------------------------------------
  kase(ctx, f, rule, value, expect, level, what) {
    const exp = { reject: this.reject(ctx), accept: new Expectation('accept'), no_5xx: new Expectation('no_5xx') }[expect];
    const verb = { reject: 'must be rejected', accept: 'must be accepted', no_5xx: 'must not cause a server error' }[expect];
    return this.make(ctx, {
      rule_id: rule, title: `${f.ref.label} ${what} ${verb}`, mutation: new Mutation('set', f.ref, value), expectation: exp, level,
      field_label: f.ref.label,
    });
  }

  missing(ctx, f, what) {
    ctx.finding('constraint_missing', `${ctx.op.operation_id} ${f.ref.label}: no ${what} documented in the spec`);
  }

  * numeric(ctx, f) {
    const s = f.schema;
    const integer = s.effective_type === 'integer';
    const step = integer ? 1 : 0.01;
    const c = s.constraints;
    const conv = f.is_param ? (v) => String(v) : (v) => v;
    let lo = c.minimum ?? null;
    let hi = c.maximum ?? null;
    let exLo = c.exclusiveMinimum;
    let exHi = c.exclusiveMaximum;
    // OAS 3.1 style numeric exclusives
    if (isNumber(exLo)) { lo = exLo; exLo = true; }
    if (isNumber(exHi)) { hi = exHi; exHi = true; }
    if (lo !== null) {
      yield this.kase(ctx, f, 'MIN-MINUS-1', conv(num(lo, -step, integer)), 'reject', 'standard', `= min-${step}`);
      yield this.kase(ctx, f, 'MIN', conv(num(lo, 0, integer)), exLo ? 'reject' : 'accept', 'standard', `= minimum ${lo}` + (exLo ? ' (exclusive)' : ''));
      yield this.kase(ctx, f, 'MIN-PLUS-1', conv(num(lo, step, integer)), 'accept', 'standard', `= min+${step}`);
    }
    if (hi !== null) {
      yield this.kase(ctx, f, 'MAX-MINUS-1', conv(num(hi, -step, integer)), 'accept', 'standard', `= max-${step}`);
      yield this.kase(ctx, f, 'MAX', conv(num(hi, 0, integer)), exHi ? 'reject' : 'accept', 'standard', `= maximum ${hi}` + (exHi ? ' (exclusive)' : ''));
      yield this.kase(ctx, f, 'MAX-PLUS-1', conv(num(hi, step, integer)), 'reject', 'standard', `= max+${step}`);
    }
    const m = c.multipleOf;
    if (isNumber(m) && m > 0) {
      const base = lo !== null ? Number(lo) : 0;
      yield this.kase(ctx, f, 'NOT-MULTIPLE-OF', conv(num(base, Number(m) * 1.5, false)), 'reject', 'standard', `not a multiple of ${m}`);
    }
    if (lo === null && hi === null) {
      this.missing(ctx, f, 'minimum/maximum');
      const values = [['GENERIC-ZERO', 0], ['GENERIC-NEGATIVE', -1]];
      if (integer && (s.format || '') !== 'int32') values.push(['GENERIC-INT32-MAX-PLUS-1', INT32_MAX + 1]);
      if (!integer) values.push(['GENERIC-HUGE', 1e15]);
      for (const [rule, v] of values) yield this.kase(ctx, f, rule, conv(v), 'no_5xx', 'full', `= ${v} (no limit documented)`);
    }
  }

  * string(ctx, f) {
    const c = f.schema.constraints;
    const lo = c.minLength ?? null;
    const hi = c.maxLength ?? null;
    const hasPattern = 'pattern' in c; // "a"*n may violate a pattern: only reject-cases are reliable then
    if (Number.isInteger(lo)) {
      if (lo > 0) yield this.kase(ctx, f, 'MINLEN-MINUS-1', 'a'.repeat(lo - 1), 'reject', 'standard', `length ${lo - 1} (< minLength ${lo})`);
      if (!hasPattern) yield this.kase(ctx, f, 'MINLEN', 'a'.repeat(Math.max(lo, 1)), 'accept', 'standard', `length ${Math.max(lo, 1)} (= minLength)`);
    }
    if (Number.isInteger(hi)) {
      if (!hasPattern) yield this.kase(ctx, f, 'MAXLEN', 'a'.repeat(hi), 'accept', 'standard', `length ${hi} (= maxLength)`);
      yield this.kase(ctx, f, 'MAXLEN-PLUS-1', 'a'.repeat(hi + 1), 'reject', 'standard', `length ${hi + 1} (> maxLength ${hi})`);
    }
    if (lo === null && hi === null) {
      this.missing(ctx, f, 'minLength/maxLength');
      if (!f.required) yield this.kase(ctx, f, 'GENERIC-EMPTY', '', 'no_5xx', 'full', 'empty (no limit documented)');
      yield this.kase(ctx, f, 'GENERIC-VERY-LONG', 'a'.repeat(LONG), 'no_5xx', 'full', `${LONG} characters (no limit documented)`);
    }
  }

  * array(ctx, f) {
    const c = f.schema.constraints;
    const items = f.value;
    const first = items.length ? deepCopy(items[0]) : null;
    const of = (n) => {
      if (first === null) return [];
      if (typeof first === 'bigint') return Array.from({ length: n }, (_, i) => normInt(first + BigInt(i)));
      if (typeof first === 'number' && Number.isInteger(first)) return Array.from({ length: n }, (_, i) => first + i); // distinct, so uniqueItems doesn't interfere
      return Array.from({ length: n }, () => deepCopy(first));
    };
    const lo = c.minItems ?? null;
    const hi = c.maxItems ?? null;
    if (Number.isInteger(lo) && lo > 0) {
      yield this.kase(ctx, f, 'MINITEMS-MINUS-1', of(lo - 1), 'reject', 'standard', `with ${lo - 1} items (< minItems ${lo})`);
      yield this.kase(ctx, f, 'MINITEMS', of(lo), 'accept', 'standard', `with ${lo} items (= minItems)`);
    }
    if (Number.isInteger(hi) && first !== null) {
      yield this.kase(ctx, f, 'MAXITEMS', of(hi), 'accept', 'standard', `with ${hi} items (= maxItems)`);
      yield this.kase(ctx, f, 'MAXITEMS-PLUS-1', of(hi + 1), 'reject', 'standard', `with ${hi + 1} items (> maxItems ${hi})`);
    }
    if (c.uniqueItems && first !== null) {
      yield this.kase(ctx, f, 'DUPLICATE-ITEMS', [first, deepCopy(first)], 'reject', 'standard', 'with duplicate items (uniqueItems)');
    }
    if (lo === null && hi === null) {
      this.missing(ctx, f, 'minItems/maxItems');
      if (!f.required) yield this.kase(ctx, f, 'GENERIC-EMPTY-ARRAY', [], 'no_5xx', 'full', 'empty (no limit documented)');
      if (first !== null) yield this.kase(ctx, f, 'GENERIC-1001-ITEMS', of(1001), 'no_5xx', 'full', 'with 1001 items (no limit documented)');
    }
  }
}
