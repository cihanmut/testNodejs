// Resource definitions (config/resources/*.yaml) and bindings: which request fields must carry the ID
// of a resource created by this run. Bindings come from config and are inferred from the spec:
// - a path parameter named <kind>Id / <kind>_id;
// - a PUT/PATCH whose JSON body uses the same schema as the create operation's body (its id field).
import fs from 'node:fs';
import { isPlainObject } from '../util/json.js';
import { yamlLoad } from '../util/yaml.js';

export class ResourceConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResourceConfigError';
  }
}

export class ResourceDef {
  constructor(init) {
    Object.assign(this, {
      kind: '',
      create_op: '',
      id_from: 'response', // response | request
      id_path: 'id', // dotted path in the response/request body
      body: {},
      create_params: {},
      delete_op: null,
      delete_params: {},
      verify_op: null,
      verify_params: {},
      verify_expect: 404,
      requires: [],
      bind: [],
      // before creating with an ID we choose (small ID ranges on shared servers): check it is free
      probe_op: null,
      probe_params: {},
      probe_expect: 404,
      probe_attempts: 5,
      // other operations that create this kind of resource (bulk create): ids taken from the request
      // with a path that may contain '*' for every list element, e.g. "*.username"
      also_created_by: [],
    }, init);
  }
}

export class Binding {
  constructor(kind, location, path) {
    this.kind = kind;
    this.location = location; // path | query | header | body
    this.path = Object.freeze([...path]); // [param name] or body key path
    Object.freeze(this);
  }

  equals(o) {
    return o.kind === this.kind && o.location === this.location && o.path.length === this.path.length && o.path.every((x, i) => x === this.path[i]);
  }
}

export function purposeFor(op) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(op.method)) return 'read';
  if (op.method === 'DELETE') return 'consume';
  return 'mutate';
}

function cleanPath(p) {
  return p.startsWith('$.') ? p.slice(2) : p.replace(/^\$+/, '');
}

export function loadResourceDefs(file) {
  if (!file) return {};
  if (!fs.existsSync(file)) throw new ResourceConfigError(`resources file not found: ${file}`);
  const data = yamlLoad(fs.readFileSync(file, 'utf8')) || {};
  const out = {};
  for (const [kind, d] of Object.entries(data)) {
    try {
      const create = d.create;
      if (!create || !('operation' in create)) throw new ResourceConfigError(`'${!create ? 'create' : 'operation'}'`);
      const del = d.delete || {};
      const verify = d.verify_deleted || {};
      const probe = create.probe || {};
      out[kind] = new ResourceDef({
        kind,
        create_op: create.operation,
        id_from: create.id_from ?? 'response',
        id_path: cleanPath(create.id_path ?? 'id'),
        body: d.body || {},
        create_params: create.params || {},
        delete_op: del.operation ?? null,
        delete_params: del.params || {},
        verify_op: verify.operation ?? null,
        verify_params: verify.params || {},
        verify_expect: Number(verify.expect ?? 404),
        requires: [...(d.requires || [])],
        bind: [...(d.bind || [])],
        probe_op: probe.operation ?? null,
        probe_params: probe.params || {},
        probe_expect: Number(probe.expect ?? 404),
        probe_attempts: Number(probe.attempts ?? 5),
        also_created_by: (d.also_created_by || []).map((a) => {
          if (!('operation' in a)) throw new ResourceConfigError("'operation'");
          return { operation: a.operation, id_path: cleanPath(a.id_path ?? create.id_path ?? 'id') };
        }),
      });
    } catch (exc) {
      throw new ResourceConfigError(`${file}: resource '${kind}' is missing ${exc instanceof ResourceConfigError ? exc.message : exc}`);
    }
    if (!['response', 'request'].includes(out[kind].id_from)) throw new ResourceConfigError(`${file}: resource '${kind}': id_from must be response or request`);
  }
  return out;
}

/** Return problems (unknown operations etc.). Resources whose operations are missing are unusable. */
export function validateDefs(defs, api) {
  const problems = [];
  for (const d of Object.values(defs)) {
    for (const opId of [d.create_op, d.delete_op, d.verify_op, d.probe_op, ...d.also_created_by.map((a) => a.operation)]) {
      if (opId && api.findOperation(opId) === null) problems.push(`resource '${d.kind}': operation '${opId}' not in spec`);
    }
    for (const req of d.requires) if (!(req in defs)) problems.push(`resource '${d.kind}' requires unknown resource '${req}'`);
  }
  return problems;
}

/** operationId -> bindings. Create operations are never bound to their own resource. */
export function inferBindings(api, defs) {
  const out = {};
  const add = (op, b) => {
    const lst = (out[op.operation_id] ||= []);
    if (!lst.some((x) => x.equals(b))) lst.push(b);
  };
  for (const d of Object.values(defs)) {
    const create = api.findOperation(d.create_op);
    const createSchema = create && create.body ? create.body.json_schema : null;
    const names = new Set([`${d.kind}id`, `${d.kind}_id`]);
    for (const op of api.operations) {
      if (op.operation_id === d.create_op) continue;
      for (const p of op.params('path')) if (names.has(p.name.toLowerCase())) add(op, new Binding(d.kind, 'path', [p.name]));
      if (['PUT', 'PATCH'].includes(op.method) && createSchema !== null && op.body && op.body.json_schema === createSchema
          && !d.id_path.includes('.') && d.id_from === 'response' && d.id_path in createSchema.properties) {
        add(op, new Binding(d.kind, 'body', [d.id_path]));
      }
    }
    for (const entry of d.bind) {
      const targets = 'operation' in entry ? [api.findOperation(entry.operation)] : api.operations;
      for (const op of targets) {
        if (op === null || op.operation_id === d.create_op) continue;
        if ('param' in entry) {
          const p = op.parameters.find((x) => x.name === entry.param);
          if (p) add(op, new Binding(d.kind, p.location, [p.name]));
        } else if ('body' in entry) {
          add(op, new Binding(d.kind, 'body', cleanPath(entry.body).split('.')));
        }
      }
    }
  }
  return out;
}

/** operationId -> [kind, wildcard id path in the request body] */
export function bulkCreateOps(defs) {
  const out = {};
  for (const d of Object.values(defs)) for (const a of d.also_created_by) out[a.operation] = [d.kind, a.id_path];
  return out;
}

/** Values at a dotted path where '*' means every list element, e.g. '*.username'. */
export function extractAll(data, dotted) {
  let nodes = [data];
  for (const part of dotted.split('.').filter(Boolean)) {
    const nxt = [];
    for (const n of nodes) {
      if (part === '*' && Array.isArray(n)) nxt.push(...n);
      else if (isPlainObject(n) && Object.prototype.hasOwnProperty.call(n, part)) nxt.push(n[part]);
      else if (Array.isArray(n) && /^\d+$/.test(part) && Number(part) < n.length) nxt.push(n[Number(part)]);
    }
    nodes = nxt;
  }
  return nodes.filter((n) => n !== null && n !== undefined && typeof n !== 'object');
}

/** [create op -> kind, delete op -> kind] */
export function resourceOps(defs) {
  const creates = {};
  const deletes = {};
  for (const d of Object.values(defs)) {
    creates[d.create_op] = d.kind;
    if (d.delete_op) deletes[d.delete_op] = d.kind;
  }
  return [creates, deletes];
}
