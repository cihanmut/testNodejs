// Build ONE valid request per operation.
//
// Value priority per field:
//   1. user overrides file (per operationId, plus "*" for all operations)
//   2. resource binding (an ID created by this run) - wins over spec examples, because PUT/DELETE must
//      never touch a resource this run did not create (spec examples like petId=10 belong to others)
//   3. spec example / default / first enum value
//   4. smart defaults by field name and format
// For resource create operations, the resource's body template (unique id, apitest-<runId> name) is
// merged over the spec-built body before user overrides.
// Date-range fix-up: if a start/end pair from examples is not a valid range, both get smart values.
import { isAuthParam } from '../auth/detect.js';
import { dumps, isPlainObject, normInt, parseJson } from '../util/json.js';
import { deepCopy, deepEqual } from '../util/py.js';
import { purposeFor } from '../resources/definitions.js';
import { MISSING } from '../spec/model.js';
import { FileValue, NO_BODY, RequestTemplate, ResourceRef } from './request.js';
import { END_DATE, START_DATE, smartValue } from './smartDefaults.js';
import { renderTemplate } from './values.js';

const MAX_DEPTH = 8;

export function deepMerge(base, over) {
  if (isPlainObject(base) && isPlainObject(over)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : deepCopy(v);
    return out;
  }
  return deepCopy(over);
}

export class BaselineBuilder {
  constructor(target, ctx, overrides = null, bindings = null, resources = null) {
    this.target = target;
    this.ctx = ctx;
    this.overrides = overrides || {};
    this.bindings = bindings || {};
    this.resources = resources || {};
    this.create_ops = Object.fromEntries(Object.values(this.resources).map((d) => [d.create_op, d]));
    this.findings = []; // documentation findings (e.g. example of the wrong type)
    this._opId = '';
  }

  // -- public -----------------------------------------------------------------------------------
  build(op) {
    this._opId = op.operation_id;
    const tpl = new RequestTemplate();
    for (const p of op.parameters) {
      if (isAuthParam(p.name, p.location, this.target.auth) || p.location === 'cookie') continue;
      const value = this.valueFor(p.schema, p.name, 0, []);
      if (value === MISSING) continue;
      if (!p.required && p.location === 'header') continue; // optional non-auth headers are left out of the baseline
      tpl.section(p.location)[p.name] = value;
    }

    if (op.body !== null) {
      const choice = op.body.choose();
      if (choice !== null) {
        const [ct, encoding] = choice;
        const schema = op.body.schemas[ct] ?? null;
        tpl.content_type = ct;
        tpl.encoding = encoding;
        if (encoding === 'binary') {
          const base = ct.split(';')[0].trim().toLowerCase();
          tpl.body = new FileValue(undefined, base.startsWith('image/') ? base : 'image/png');
        } else {
          tpl.body = schema !== null ? this.valueFor(schema, '', 0, []) : {};
          if (tpl.body === MISSING) tpl.body = {};
        }
      } else if (op.body.required) {
        tpl.body = NO_BODY; // unsupported (non-JSON) required body; op is skipped
      }
    }

    const rdef = this.create_ops[op.operation_id];
    if (rdef) {
      const rendered = renderTemplate(rdef.body, this.ctx);
      if (rendered && Object.keys(rendered).length) tpl.body = deepMerge(isPlainObject(tpl.body) ? tpl.body : {}, rendered);
      for (const [name, v] of Object.entries(renderTemplate(rdef.create_params, this.ctx) || {})) this.setParam(op, tpl, name, v);
    }

    for (const b of this.bindings[op.operation_id] || []) {
      const ref = new ResourceRef(b.kind, purposeFor(op));
      if (b.location === 'body') {
        if (isPlainObject(tpl.body)) {
          // updates of our resource keep its recognisable test data (apitest-<runId> name ...)
          const rbody = this.resources[b.kind] ? this.resources[b.kind].body : null;
          if (rbody && Object.keys(rbody).length) tpl.body = deepMerge(tpl.body, renderTemplate(rbody, this.ctx));
          BaselineBuilder.setBodyPath(tpl.body, b.path, ref);
        }
      } else {
        tpl.section(b.location)[b.path[0]] = ref;
      }
    }

    this.fixDateRanges(tpl.body);
    this.applyOverrides(op, tpl);
    return tpl;
  }

  // -- values -----------------------------------------------------------------------------------
  valueFor(schema, name, depth, stack) {
    if (schema.effective_type === 'file' || (schema.effective_type === 'string' && schema.format === 'binary')) return new FileValue();
    if (schema.example !== MISSING) {
      const ex = this.fit(schema.example, schema, name, 'example');
      if (ex !== MISSING) return ex;
    }
    if (schema.default !== MISSING) {
      const dv = this.fit(schema.default, schema, name, 'default');
      if (dv !== MISSING) return dv;
    }
    if (schema.enum && schema.enum.length) return schema.enum[0];
    const t = schema.effective_type;
    if (t === null && schema.one_of.length) return this.valueFor(schema.one_of[0], name, depth, stack);
    if (t === 'object') {
      if (depth >= MAX_DEPTH || stack.includes(schema)) return MISSING;
      const out = {};
      for (const [prop, sub] of Object.entries(schema.properties)) {
        if (sub.read_only) continue;
        const v = this.valueFor(sub, prop, depth + 1, [...stack, schema]);
        if (v === MISSING) {
          if (schema.required.has(prop)) out[prop] = {};
          continue;
        }
        out[prop] = v;
      }
      return out;
    }
    if (t === 'array') {
      if (schema.items === null || depth >= MAX_DEPTH) return [];
      const item = this.valueFor(schema.items, name, depth + 1, stack);
      if (item === MISSING) return [];
      const n = Number(schema.constraints.minItems) || 1;
      return Array.from({ length: Math.max(1, Math.trunc(n)) }, () => deepCopy(item));
    }
    return smartValue(name, schema, this.ctx);
  }

  /** Use a spec example/default only if it fits the declared type. A wrong-typed value is converted when
   *  that is unambiguous (JSON text for an array/object, numeric text for a number), otherwise ignored;
   *  either way it is reported as a documentation finding. */
  fit(value, schema, name, what) {
    const t = schema.effective_type;
    if (fits(value, t)) return deepCopy(value);
    const converted = convert(value, t);
    const fixed = converted !== MISSING && fits(converted, t);
    let shown;
    try {
      shown = dumps(value).slice(0, 60);
    } catch {
      shown = String(value).slice(0, 60);
    }
    const msg = `${this._opId}: ${what} of '${name || 'body'}' is ${pyTypeName(value)} ${shown} but the field is ${t}` + (fixed ? ' (converted)' : ' (ignored)');
    const entry = { kind: 'example_type_mismatch', message: msg, operations: [this._opId] };
    if (!this.findings.some((f) => deepEqual(f, entry))) this.findings.push(entry);
    return fixed ? converted : MISSING;
  }

  // -- helpers ----------------------------------------------------------------------------------
  static setBodyPath(body, path, value) {
    let node = body;
    for (const part of path.slice(0, -1)) {
      if (!(part in node)) node[part] = {};
      node = node[part];
    }
    node[path[path.length - 1]] = value;
  }

  setParam(op, tpl, name, value) {
    const p = op.parameters.find((x) => x.name === name);
    tpl.section(p ? p.location : 'query')[name] = value;
  }

  fixDateRanges(node) {
    if (Array.isArray(node)) {
      node.forEach((x) => this.fixDateRanges(x));
      return;
    }
    if (!isPlainObject(node)) return;
    const starts = Object.keys(node).filter((k) => START_DATE.test(k) && typeof node[k] === 'string');
    const ends = Object.keys(node).filter((k) => END_DATE.test(k) && typeof node[k] === 'string');
    if (starts.length === 1 && ends.length === 1) {
      const s = node[starts[0]];
      const e = node[ends[0]];
      if (s >= e) { // ISO strings with the same offset compare chronologically
        node[starts[0]] = this.ctx.midnight(-7);
        node[ends[0]] = this.ctx.midnight(-1);
      }
    }
    for (const v of Object.values(node)) this.fixDateRanges(v);
  }

  applyOverrides(op, tpl) {
    for (const key of ['*', op.operation_id]) {
      let ov = this.overrides[key];
      if (!ov || (isPlainObject(ov) && !Object.keys(ov).length)) continue;
      ov = renderTemplate(ov, this.ctx);
      if (key === '*') {
        // global overrides only touch fields the operation actually has
        if ('body' in ov && isPlainObject(tpl.body)) {
          const picked = Object.fromEntries(Object.entries(ov.body).filter(([k]) => k in tpl.body));
          tpl.body = deepMerge(tpl.body, picked);
        }
        for (const loc of ['path', 'query', 'headers']) {
          const sec = loc === 'headers' ? tpl.headers : tpl.section(loc);
          for (const [k, v] of Object.entries(ov[loc] || {})) if (k in sec) sec[k] = v;
        }
        continue;
      }
      if ('body' in ov) tpl.body = isPlainObject(ov.body) ? deepMerge(isPlainObject(tpl.body) ? tpl.body : {}, ov.body) : ov.body;
      for (const loc of ['path', 'query']) Object.assign(tpl.section(loc), ov[loc] || {});
      Object.assign(tpl.headers, ov.headers || {});
    }
  }
}

export function pyTypeName(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'bigint' || Number.isInteger(v)) return 'int';
  if (typeof v === 'number') return 'float';
  if (Array.isArray(v)) return 'list';
  return 'dict';
}

export const isInt = (v) => typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v));
export const isNum = (v) => typeof v === 'bigint' || typeof v === 'number';

function fits(value, t) {
  if (t === null || value === null) return true;
  switch (t) {
    case 'string': return typeof value === 'string';
    case 'integer': return isInt(value);
    case 'number': return isNum(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return isPlainObject(value);
    default: return true;
  }
}

function convert(value, t) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (t === 'array' || t === 'object') {
      try {
        return parseJson(text);
      } catch {
        return MISSING;
      }
    }
    if (t === 'integer' && /^-?\d+$/.test(text) && text.replace(/^-/, '').length) return normInt(BigInt(text));
    if (t === 'number') {
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return MISSING;
      return Number(text);
    }
    if (t === 'boolean' && ['true', 'false'].includes(text.toLowerCase())) return text.toLowerCase() === 'true';
  }
  if (t === 'string' && isNum(value)) return String(value);
  return MISSING;
}
