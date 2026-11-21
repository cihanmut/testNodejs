// Validate response bodies against model Schemas. The model is first converted to a JSON Schema
// (draft-07 subset, named schemas as #/definitions/<name>, so recursive schemas are fine), then checked by
// a small built-in validator (replaces Python's fastjsonschema; no npm package needed).
// Error messages follow fastjsonschema's style: "data.id must be integer (at data.id)".
import { isPlainObject } from '../util/json.js';
import { deepEqual, pyRegex } from '../util/py.js';
import { Schema } from '../spec/model.js';

const KEEP_FORMATS = new Set(['date-time', 'date', 'email', 'uuid']);
const PASSTHROUGH = ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems'];
const isNum = (v) => typeof v === 'number' || typeof v === 'bigint';

export function toJsonSchema(root) {
  const defs = {};
  const conv = (s, inline = false) => {
    if (s.ref_name && !inline) {
      const name = s.ref_name;
      if (!(name in defs)) {
        defs[name] = {}; // placeholder breaks cycles
        defs[name] = conv(s, true);
      }
      return { $ref: `#/definitions/${name}` };
    }
    const out = {};
    const t = s.effective_type;
    if (t) out.type = s.nullable ? [t, 'null'] : t;
    if (s.enum !== null) out.enum = [...s.enum, ...(s.nullable && !s.enum.includes(null) ? [null] : [])];
    if (t === 'string' && KEEP_FORMATS.has(s.format)) out.format = s.format;
    for (const key of PASSTHROUGH) if (key in s.constraints) out[key] = s.constraints[key];
    for (const [key, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']]) {
      const v = s.constraints[key];
      if (v === true && bound in s.constraints) { // OAS 3.0 / Swagger boolean style
        out[key] = s.constraints[bound];
        delete out[bound];
      } else if (isNum(v)) {
        out[key] = v;
      }
    }
    if (Object.keys(s.properties).length) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, conv(v)]));
    const req = [...s.required].filter((r) => !(r in s.properties && s.properties[r].write_only)).sort();
    if (req.length) out.required = req;
    if (s.items !== null) out.items = conv(s.items);
    if (s.additional_properties instanceof Schema) out.additionalProperties = conv(s.additional_properties);
    else if (s.additional_properties === false) out.additionalProperties = false;
    if (s.one_of.length) out.anyOf = s.one_of.map((x) => conv(x));
    return out;
  };
  const body = conv(root);
  return { $schema: 'http://json-schema.org/draft-07/schema#', allOf: [body], definitions: defs };
}

// -------------------------------------------------------------------------------------- validator
const FORMATS = {
  'date-time': /^\d{4}-[01]\d-[0-3]\d[tT][0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?(?:[+-][0-2]\d:[0-5]\d|[+-][0-2]\d[0-5]\d|z|Z)$/,
  date: /^\d{4}-[01]\d-[0-3]\d$/,
  email: /^[^@]+@[^@]+\.[^@]+$/,
  uuid: /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/,
};

class Invalid extends Error {
  constructor(message, path) {
    super(message);
    this.path = path;
  }
}

function typeOk(t, v) {
  switch (t) {
    case 'null': return v === null;
    case 'boolean': return typeof v === 'boolean';
    case 'string': return typeof v === 'string';
    case 'integer': return typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v));
    case 'number': return isNum(v);
    case 'array': return Array.isArray(v);
    case 'object': return isPlainObject(v);
    default: return true;
  }
}

const n = (v) => (typeof v === 'bigint' ? Number(v) : v);
const fmtList = (xs) => '[' + xs.map((x) => (typeof x === 'string' ? `'${x}'` : String(x))).join(', ') + ']';

function check(schema, data, path, root) {
  if (schema === true || schema === undefined) return;
  if (schema.$ref) {
    const name = schema.$ref.replace('#/definitions/', '');
    check(root.definitions[name], data, path, root);
    return;
  }
  for (const sub of schema.allOf || []) check(sub, data, path, root);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, data))) throw new Invalid(`${path} must be ${types.join(' or ')}`, path);
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, data))) throw new Invalid(`${path} must be one of ${fmtList(schema.enum)}`, path);
  if (schema.anyOf) {
    const okAny = schema.anyOf.some((sub) => {
      try {
        check(sub, data, path, root);
        return true;
      } catch (e) {
        if (e instanceof Invalid) return false;
        throw e;
      }
    });
    if (!okAny) throw new Invalid(`${path} cannot be validated by any definition`, path);
  }
  if (typeof data === 'string') {
    if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format].test(data)) throw new Invalid(`${path} must be ${schema.format}`, path);
    const len = [...data].length;
    if (schema.minLength !== undefined && len < schema.minLength) throw new Invalid(`${path} must be longer than or equal to ${schema.minLength} characters`, path);
    if (schema.maxLength !== undefined && len > schema.maxLength) throw new Invalid(`${path} must be shorter than or equal to ${schema.maxLength} characters`, path);
    if (schema.pattern !== undefined) {
      let rx = null;
      try {
        rx = pyRegex(schema.pattern);
      } catch {
        rx = null; // an uncompilable spec pattern cannot be checked
      }
      if (rx && !rx.test(data)) throw new Invalid(`${path} must match pattern ${schema.pattern}`, path);
    }
  }
  if (isNum(data) && typeof data !== 'boolean') {
    const v = n(data);
    if (schema.minimum !== undefined && v < n(schema.minimum)) throw new Invalid(`${path} must be bigger than or equal to ${schema.minimum}`, path);
    if (schema.maximum !== undefined && v > n(schema.maximum)) throw new Invalid(`${path} must be smaller than or equal to ${schema.maximum}`, path);
    if (schema.exclusiveMinimum !== undefined && isNum(schema.exclusiveMinimum) && v <= n(schema.exclusiveMinimum)) throw new Invalid(`${path} must be bigger than ${schema.exclusiveMinimum}`, path);
    if (schema.exclusiveMaximum !== undefined && isNum(schema.exclusiveMaximum) && v >= n(schema.exclusiveMaximum)) throw new Invalid(`${path} must be smaller than ${schema.exclusiveMaximum}`, path);
    if (schema.multipleOf !== undefined && n(schema.multipleOf) > 0) {
      const q = v / n(schema.multipleOf);
      if (Math.abs(q - Math.round(q)) > 1e-9) throw new Invalid(`${path} must be multiple of ${schema.multipleOf}`, path);
    }
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) throw new Invalid(`${path} must contain at least ${schema.minItems} items`, path);
    if (schema.maxItems !== undefined && data.length > schema.maxItems) throw new Invalid(`${path} must contain less than or equal to ${schema.maxItems} items`, path);
    if (schema.uniqueItems) {
      for (let i = 0; i < data.length; i++) for (let j = i + 1; j < data.length; j++) if (deepEqual(data[i], data[j])) throw new Invalid(`${path} must contain unique items`, path);
    }
    if (schema.items !== undefined) data.forEach((x, i) => check(schema.items, x, `${path}[${i}]`, root));
  }
  if (isPlainObject(data)) {
    if (schema.required) {
      const missing = schema.required.filter((k) => !Object.prototype.hasOwnProperty.call(data, k));
      if (missing.length) throw new Invalid(`${path} must contain ${fmtList(schema.required)} properties`, path);
    }
    const props = schema.properties || {};
    for (const [k, sub] of Object.entries(props)) if (Object.prototype.hasOwnProperty.call(data, k)) check(sub, data[k], `${path}.${k}`, root);
    if (schema.additionalProperties !== undefined) {
      for (const k of Object.keys(data)) {
        if (k in props) continue;
        if (schema.additionalProperties === false) throw new Invalid(`${path} must not contain {'${k}'} properties`, path);
        check(schema.additionalProperties, data[k], `${path}.${k}`, root);
      }
    }
  }
}

export class SchemaValidator {
  constructor() {
    this._cache = new Map();
  }

  /** null if valid, else a short error message (first violation, with its path). */
  validate(schema, data) {
    let js = this._cache.get(schema);
    if (!js) {
      try {
        js = toJsonSchema(schema);
      } catch (exc) {
        js = exc;
      }
      this._cache.set(schema, js);
    }
    if (js instanceof Error) return null; // cannot validate against an unconvertible schema; reported by analyze
    try {
      check(js, data, 'data', js);
      return null;
    } catch (exc) {
      if (exc instanceof Invalid) return `${exc.message} (at ${exc.path})`;
      if (exc instanceof RangeError) return null; // pathological recursion in a broken spec
      throw exc;
    }
  }
}
