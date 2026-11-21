// Generator framework: TestCase model, field enumeration, registry, deterministic case IDs.
//
// Core rule: every non-baseline case = baseline + exactly ONE mutation.
import crypto from 'node:crypto';
import { isAuthParam } from '../auth/detect.js';
import { LEVELS } from '../config/models.js';
import { NO_BODY, OMIT, FieldRef, ResourceRef, toDisplay } from '../data/request.js';
import { dumps, isPlainObject } from '../util/json.js';
import { deepEqual, pyRepr } from '../util/py.js';

export const LEVEL_RANK = Object.freeze(Object.fromEntries(LEVELS.map((lv, i) => [lv, i])));
export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;
const NUMERIC = /^\s*[-+]?\d+(\.\d*)?([eE][-+]?\d+)?\s*$/;

/** key of a (location, path) pair, for sets of fields */
export const fieldKey = (location, path) => location + '|' + JSON.stringify(path);

/** kind:
 *   none         baseline
 *   set          field := value (OMIT removes it; FieldRef("body", []) replaces the whole body)
 *   auth         AUTH variant, value = rule id
 *   replace      value = {path, query, headers, body} (e.g. only-required-fields)
 *   raw_body     value = raw text sent as the body (malformed JSON, empty body)
 *   content_type value = Content-Type header to send with the normal JSON body
 *   method       value = {method: "PATCH"}; resource refs switch to purpose consume if not GET
 *   path         value = absolute path (unknown path), sent with GET and no params/body
 *   tombstone    field := an ID guaranteed not to exist (created, deleted, verified 404) */
export class Mutation {
  constructor(kind, field = null, value = null) {
    this.kind = kind;
    this.field = field;
    this.value = value;
    Object.freeze(this);
  }
}

export class Expectation {
  constructor(kind, codes = []) {
    this.kind = kind; // accept | reject | auth_reject | no_5xx
    this.codes = Object.freeze([...codes]);
    Object.freeze(this);
  }
}

export class TestCase {
  constructor({ id, target, operation_id, technique, group, field, rule_id, title, mutation, expectation, level, needs_auth }) {
    Object.assign(this, { id, target, operation_id, technique, group, field, rule_id, title, mutation, expectation, level, needs_auth });
  }

  get is_baseline() {
    return this.technique === 'BASE';
  }

  summary() {
    return {
      id: this.id, operation_id: this.operation_id, technique: this.technique, group: this.group, field: this.field,
      rule_id: this.rule_id, title: this.title, level: this.level, expect: this.expectation.kind,
      expect_codes: [...this.expectation.codes], value: summaryValue(this.mutation),
    };
  }
}

export class GenContext {
  constructor(init) {
    Object.assign(this, {
      target: null,
      op: null,
      baseline: null,
      auth: null,
      reject_codes: [],
      bindings: [],
      own_resources_only: true,
      // ID fields we supply ourselves on create operations (e.g. addPet body.id = {unique_int}):
      // a mutated value there could make a lenient server overwrite someone else's resource.
      own_id_fields: new Set(),
      // bound/own ID fields whose IDs are strings (e.g. username): ANY string could be someone else's
      string_id_fields: new Set(),
      value_ctx: null, // ValueContext (dates for domain rules)
      rules: [], // DomainRule list
      path_methods: new Set(), // documented methods on this op's path
      first_on_path: false,
      first_op: false,
      findings: [], // plan-level documentation findings
      allow_injection: false, // only when the profile allows it AND --allow-injection was given
    }, init);
  }

  bound(ref) {
    if (this.bindings.some((b) => b.location === ref.location && b.path.length === ref.path.length && b.path.every((x, i) => x === ref.path[i]))) return true;
    return this.own_id_fields.has(fieldKey(ref.location, ref.path));
  }

  finding(kind, message) {
    const entry = { kind, message, operations: [this.op.operation_id] };
    if (!this.findings.some((f) => deepEqual(f, entry))) this.findings.push(entry);
  }
}

export class FieldInfo {
  constructor(ref, schema, required, is_param, value) {
    Object.assign(this, { ref, schema, required, is_param, value });
  }
}

export function valueRepr(value) {
  if (value === OMIT) return '<omit>';
  try {
    return dumps(toDisplay(value), { sortKeys: true });
  } catch {
    return pyRepr(value);
  }
}

function summaryValue(m) {
  switch (m.kind) {
    case 'set': return valueRepr(m.value);
    case 'auth': case 'content_type': case 'path': return m.value;
    case 'raw_body': return pyRepr(m.value);
    case 'method': return m.value.method;
    case 'tombstone': return '<id guaranteed not to exist>';
    default: return null;
  }
}

export function caseId(target, opId, technique, fieldLabel, ruleId, value) {
  const key = [target, opId, technique, fieldLabel || '', ruleId, valueRepr(value)].join('|');
  return 'TC-' + crypto.createHash('sha1').update(key, 'utf8').digest('hex').slice(0, 10);
}

/** Parameters (except the auth header) and body fields present in the baseline, incl. nested objects and
 *  the first element of arrays. */
export function* iterFields(op, baseline, target) {
  for (const p of op.parameters) {
    if (p.location === 'cookie' || isAuthParam(p.name, p.location, target.auth)) continue;
    const sec = baseline.section(p.location);
    if (!Object.prototype.hasOwnProperty.call(sec, p.name)) continue;
    yield new FieldInfo(new FieldRef(p.location, [p.name]), p.schema, p.required, true, sec[p.name]);
  }
  if (baseline.body === NO_BODY || op.body === null || baseline.encoding === 'binary') return;
  const schema = baseline.content_type ? op.body.schemas[baseline.content_type] ?? null : null;
  if (schema === null) return;
  // form/multipart fields travel as text, like parameters: type tests use text values
  yield* walkBody(schema, baseline.body, [], 0, new Set(), ['form', 'multipart'].includes(baseline.encoding));
}

function* walkBody(schema, value, path, depth, stack, textual = false) {
  if (depth > 8) return;
  const t = schema.effective_type;
  if (t === 'object' && isPlainObject(value)) {
    if (stack.has(schema)) return;
    stack = new Set([...stack, schema]);
    for (const [name, sub] of Object.entries(schema.properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, name) || sub.read_only) continue;
      const p = [...path, name];
      yield new FieldInfo(new FieldRef('body', p), sub, schema.required.has(name), textual, value[name]);
      yield* walkBody(sub, value[name], p, depth + 1, stack, textual);
    }
  } else if (t === 'array' && Array.isArray(value) && value.length && schema.items !== null) {
    const item = schema.items;
    if (item.effective_type === 'object' || item.effective_type === 'array') yield* walkBody(item, value[0], [...path, 0], depth + 1, stack, textual);
  }
}

/** Can this value be sent in a field that must hold OUR resource ID, on a state-changing request, without
 *  risking hitting someone else's resource? Lenient servers coerce 1.5 -> 1, true -> 1, "12" -> 12, and
 *  an omitted ID may default to 0. Only clearly non-ID values are safe. */
export function ownershipSafe(value) {
  if (value === OMIT || value === null || value === undefined || typeof value === 'boolean' || Array.isArray(value)) return false;
  if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))) {
    const b = BigInt(value);
    return !(b >= INT64_MIN && b <= INT64_MAX);
  }
  if (typeof value === 'number') return false; // a decimal: coerced to an integer by lenient servers
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^[-+]?\d+$/.test(text)) {
      const b = BigInt(text);
      return !(b >= INT64_MIN && b <= INT64_MAX); // e.g. int64 overflow sent as text
    }
    return Boolean(text) && !NUMERIC.test(text) && !['true', 'false'].includes(text.toLowerCase());
  }
  return isPlainObject(value);
}

export class Generator {
  static technique = '';
  static group = 'validation';

  get technique() {
    return this.constructor.technique;
  }

  get group() {
    return this.constructor.group;
  }

  /** @returns {TestCase[]} */
  generate(_ctx) { // eslint-disable-line no-unused-vars
    throw new Error('not implemented');
  }

  // helpers ------------------------------------------------------------------------------------
  make(ctx, { rule_id, title, mutation, expectation, level, field_label = null, technique = null, group = null }) {
    technique = technique || this.technique;
    const value = ['set', 'auth'].includes(mutation.kind) ? mutation.value : rule_id;
    if (mutation.kind === 'set' && mutation.field !== null && ctx.own_resources_only
        && !['GET', 'HEAD', 'OPTIONS'].includes(ctx.op.method) && ctx.bound(mutation.field)) {
      if (ctx.string_id_fields.has(fieldKey(mutation.field.location, mutation.field.path))) return null; // string IDs: any value could be someone else's
      if (!ownershipSafe(mutation.value)) return null; // could hit a resource we do not own
    }
    if (mutation.kind === 'set' && mutation.field !== null && mutation.value !== OMIT) {
      let current;
      try {
        current = ctx.baseline.get(mutation.field);
      } catch {
        current = OMIT;
      }
      if (current !== OMIT && valueRepr(current) === valueRepr(mutation.value)) return null; // same as the baseline: the case would change nothing
    }
    return new TestCase({
      id: caseId(ctx.target.name, ctx.op.operation_id, technique, field_label, rule_id, value),
      target: ctx.target.name, operation_id: ctx.op.operation_id, technique, group: group || this.group,
      field: field_label, rule_id, title, mutation, expectation, level, needs_auth: ctx.auth.needs,
    });
  }

  reject(ctx) {
    return new Expectation('reject', ctx.reject_codes);
  }
}

export const REGISTRY = [];

export function register(cls) {
  REGISTRY.push(cls);
  return cls;
}

export const isResourceRef = (value) => value instanceof ResourceRef;
