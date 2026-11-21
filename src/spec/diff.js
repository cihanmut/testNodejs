// Compare two spec versions and list what changed per operation, so only changed operations need
// testing (`apitest diff`, `generate/run --changed-since`).
//
// Operations are matched by "METHOD /path" (operationIds may be renamed). Compared: parameters,
// request body (content types + schema field by field), responses (codes + schemas), security.
// Descriptions, summaries and examples are ignored: they don't change behaviour.
import { dumps } from '../util/json.js';
import { deepEqual, pyStr, sorted } from '../util/py.js';
import { CONSTRAINT_KEYS } from './model.js';

const MAX_DEPTH = 10;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function describe(s) {
  const d = { type: s.effective_type };
  if (s.format) d.format = s.format;
  if (s.enum !== null) d.enum = sorted(s.enum.map((x) => pyStr(x)));
  if (s.nullable) d.nullable = true;
  if (s.read_only) d.readOnly = true;
  for (const k of CONSTRAINT_KEYS) if (k in s.constraints) d[k] = s.constraints[k];
  return d;
}

/** path -> descriptor for every node of the schema (cycle- and depth-safe). */
export function flattenSchema(s, prefix, out, required = null, depth = 0, stack = []) {
  if (s === null || s === undefined) return;
  if (stack.includes(s) || depth > MAX_DEPTH) {
    out[prefix] = { $recursive: s.ref_name || '?' };
    return;
  }
  const d = describe(s);
  if (required !== null) d.required = required;
  out[prefix] = d;
  stack = [...stack, s];
  for (const [name, sub] of Object.entries(s.properties)) flattenSchema(sub, `${prefix}.${name}`, out, s.required.has(name), depth + 1, stack);
  if (s.items !== null) flattenSchema(s.items, `${prefix}[]`, out, null, depth + 1, stack);
  s.one_of.forEach((alt, i) => flattenSchema(alt, `${prefix}<oneOf${i}>`, out, null, depth + 1, stack));
}

export function opFingerprint(op) {
  const out = {};
  for (const p of op.parameters) flattenSchema(p.schema, `${p.location}.${p.name}`, out, p.required);
  if (op.body !== null) {
    out['body:content-types'] = sorted(op.body.content_types);
    out['body:required'] = op.body.required;
    flattenSchema(op.body.chosen_schema || op.body.json_schema, 'body', out);
  }
  for (const [code, r] of Object.entries(op.responses)) {
    out[`response ${code}`] = { 'content-types': sorted(r.content_types) };
    flattenSchema(r.schema, `response ${code}.body`, out);
  }
  out.security = sorted(op.security.map((a) => sorted(a).join('+')));
  return out;
}

/** Python str() of descriptor values (lists like ['a', 'b'], True/False). */
function show(v) {
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v === null) return 'None';
  if (Array.isArray(v)) return '[' + v.map((x) => (typeof x === 'string' ? `'${x}'` : show(x))).join(', ') + ']';
  if (isObj(v)) return dumps(v);
  return String(v);
}

function fmt(v) {
  if (isObj(v)) return sorted(Object.keys(v)).map((k) => `${k}=${show(v[k])}`).join(', ');
  return show(v);
}

export function compareFingerprints(oldFp, newFp) {
  const changes = [];
  for (const key of sorted(new Set([...Object.keys(oldFp), ...Object.keys(newFp)]))) {
    if (!(key in oldFp)) {
      const req = isObj(newFp[key]) && newFp[key].required;
      changes.push(`+ ${key} added` + (req ? ' (required)' : '') + `: ${fmt(newFp[key])}`);
    } else if (!(key in newFp)) {
      changes.push(`- ${key} removed`);
    } else if (!deepEqual(oldFp[key], newFp[key])) {
      const a0 = oldFp[key];
      const b0 = newFp[key];
      if (isObj(a0) && isObj(b0)) {
        const parts = [];
        for (const k of sorted(new Set([...Object.keys(a0), ...Object.keys(b0)]))) {
          const a = k in a0 ? a0[k] : '—';
          const b = k in b0 ? b0[k] : '—';
          if (!deepEqual(a, b)) parts.push(`${k} ${show(a)} → ${show(b)}`);
        }
        changes.push(`~ ${key}: ` + parts.join('; '));
      } else {
        changes.push(`~ ${key}: ${show(a0)} → ${show(b0)}`);
      }
    }
  }
  return changes;
}

export class SpecDiff {
  constructor(oldTitle, newTitle, oldVersion, newVersion) {
    this.old_title = oldTitle;
    this.new_title = newTitle;
    this.old_version = oldVersion;
    this.new_version = newVersion;
    this.added = []; // "METHOD /path (operationId)"
    this.removed = [];
    this.changed = {};
    this.renamed = {}; // op key -> "old id → new id"
    this.unchanged = 0;
  }

  /** 'METHOD /path' of operations that are new or changed (removed ones can't be tested). */
  get keys_to_test() {
    return [...this.added.map((k) => k.split(' (')[0]), ...Object.keys(this.changed)];
  }

  toDict() {
    const { old_title, new_title, old_version, new_version, added, removed, changed, renamed, unchanged } = this;
    return { old_title, new_title, old_version, new_version, added, removed, changed, renamed, unchanged };
  }

  format() {
    const lines = [
      `old: ${this.old_title} ${this.old_version}`,
      `new: ${this.new_title} ${this.new_version}`,
      `added ${this.added.length} · removed ${this.removed.length} · changed ${Object.keys(this.changed).length} · unchanged ${this.unchanged}`,
    ];
    for (const k of this.added) lines.push(`  + ${k}`);
    for (const k of this.removed) lines.push(`  - ${k}`);
    for (const [k, changes] of Object.entries(this.changed)) {
      lines.push(`  ~ ${k}` + (k in this.renamed ? `   [operationId ${this.renamed[k]}]` : ''));
      for (const c of changes.slice(0, 40)) lines.push(`      ${c}`);
      if (changes.length > 40) lines.push(`      … ${changes.length - 40} more`);
    }
    for (const [k, r] of Object.entries(this.renamed)) {
      if (!(k in this.changed)) lines.push(`  = ${k}   [operationId ${r}, otherwise unchanged]`);
    }
    return lines.join('\n');
  }
}

export function diffSpecs(oldApi, newApi) {
  const o = new Map(oldApi.operations.map((op) => [op.key, op]));
  const n = new Map(newApi.operations.map((op) => [op.key, op]));
  const d = new SpecDiff(oldApi.title, newApi.title, oldApi.spec_version, newApi.spec_version);
  for (const [key, op] of n) if (!o.has(key)) d.added.push(`${key} (${op.operation_id})`);
  for (const [key, op] of o) if (!n.has(key)) d.removed.push(`${key} (${op.operation_id})`);
  for (const [key, nop] of n) {
    if (!o.has(key)) continue;
    const oop = o.get(key);
    const changes = compareFingerprints(opFingerprint(oop), opFingerprint(nop));
    if (oop.operation_id !== nop.operation_id) d.renamed[key] = `${oop.operation_id} → ${nop.operation_id}`;
    if (changes.length) d.changed[key] = changes;
    else d.unchanged += 1;
  }
  return d;
}
