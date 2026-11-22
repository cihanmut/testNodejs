// Build the test plan: filtered operations -> baseline + cases. Pure (no network); used by
// `generate --dry-run`, `run` and `run --resume` (resume regenerates the identical plan).
import { detectAuth } from '../auth/detect.js';
import { LEVELS } from '../config/models.js';
import { BaselineBuilder } from '../data/baseline.js';
import { ValueContext } from '../data/values.js';
import { inferBindings } from '../resources/definitions.js';
import { Counter, fnmatch } from '../util/py.js';
import { GenContext, LEVEL_RANK, REGISTRY, fieldKey, register } from './base.js';
import { BoundaryGenerator } from './boundary.js';
import { ExportTypeGenerator } from './exports.js';
import { InjectionGenerator } from './injection.js';
import { ProtocolGenerator } from './protocol.js';
import { DomainRuleGenerator, loadRules } from './rules.js';
import { AuthGenerator, BaselineGenerator, DataTypeGenerator, RequiredFieldGenerator } from './techniques.js';

// Registration order = order of the cases inside an operation (same as the Python tool's import order).
if (!REGISTRY.length) {
  for (const cls of [BoundaryGenerator, ExportTypeGenerator, InjectionGenerator, ProtocolGenerator, DomainRuleGenerator,
    BaselineGenerator, AuthGenerator, RequiredFieldGenerator, DataTypeGenerator]) register(cls);
}

export class Filters {
  constructor({ tags = [], paths = [], methods = [], operations = [], op_keys = [] } = {}) {
    this.tags = [...tags];
    this.paths = [...paths]; // glob
    this.methods = [...methods];
    this.operations = [...operations]; // glob on operationId
    this.op_keys = [...op_keys]; // exact "METHOD /path" (e.g. from --changed-since)
  }

  match(op) {
    if (this.op_keys.length && !this.op_keys.includes(op.key)) return false;
    if (this.tags.length && !this.tags.some((t) => op.tags.includes(t))) return false;
    if (this.paths.length && !this.paths.some((p) => fnmatch(op.path, p))) return false;
    if (this.methods.length && !this.methods.map((m) => m.toUpperCase()).includes(op.method)) return false;
    if (this.operations.length && !this.operations.some((p) => fnmatch(op.operation_id, p))) return false;
    return true;
  }

  toDict() {
    return { tags: this.tags, paths: this.paths, methods: this.methods, operations: this.operations, op_keys: this.op_keys };
  }

  /** The target's default filter (`filters:` in the target config); empty = all operations. */
  static forTarget(target) {
    const f = new Filters(target.filters || {});
    f.fromTarget = true;
    return f;
  }

  /** Warnings for filter values that match no operation of the spec at all (typos in a tag name etc.). */
  unmatched(operations) {
    const warnings = [];
    const allTags = [...new Set(operations.flatMap((op) => op.tags))].sort();
    for (const t of this.tags) {
      if (!allTags.includes(t)) warnings.push(`tag '${t}' matches no operation. Tags in this spec: ${allTags.join(', ') || '(none)'}`);
    }
    for (const p of this.paths) {
      if (!operations.some((op) => fnmatch(op.path, p))) warnings.push(`path '${p}' matches no operation (paths are globs on the spec path, e.g. '/v1/data/*')`);
    }
    for (const m of this.methods) {
      if (!operations.some((op) => op.method === m.toUpperCase())) warnings.push(`method '${m}' matches no operation`);
    }
    for (const o of this.operations) {
      if (!operations.some((op) => fnmatch(op.operation_id, o))) warnings.push(`operationId '${o}' matches no operation`);
    }
    return warnings;
  }
}

export class OpPlan {
  constructor(op, auth, baseline, cases, bindings, skip_reason = null) {
    Object.assign(this, { op, auth, baseline, cases, bindings, skip_reason }); // skip_reason: whole operation cannot run
  }
}

export class Plan {
  constructor({ target, level, ops }) {
    this.target = target;
    this.level = level;
    this.ops = ops;
    this.excluded_exports = 0;
    this.filtered_out = 0;
    this.filter_warnings = []; // filter values that match nothing in the spec
    this.findings = []; // documentation findings found while generating
    this.ops_with_cases = 0;
  }

  get cases() {
    return this.ops.flatMap((p) => p.cases);
  }

  countsByTechnique() {
    return Counter.of(this.cases.map((c) => c.technique));
  }
}

/** In own-resources-only profiles, a state-changing operation must have every path ID bound to a resource
 *  this run creates; PUT/PATCH/DELETE without any binding could change someone else's data. */
export function ownershipSkipReason(op, bindings, profile) {
  if (!profile.own_resources_only || ['GET', 'HEAD', 'OPTIONS'].includes(op.method)) return null;
  const bound = new Set(bindings.filter((b) => b.location !== 'body').map((b) => `${b.location}|${b.path[0]}`));
  const unbound = op.params('path').filter((p) => !bound.has(`path|${p.name}`)).map((p) => p.name);
  if (unbound.length) return `${op.method} with path parameter(s) ${unbound.join(', ')} not bound to a resource created by this run`;
  if (['PUT', 'PATCH', 'DELETE'].includes(op.method) && !bindings.length) return `${op.method} without a resource binding could modify data this run did not create`;
  return null;
}

function schemaAt(schema, path) {
  let node = schema;
  for (const part of path) {
    if (node === null || node === undefined) return null;
    node = part === '*' || typeof part === 'number' ? node.items : node.properties[part] ?? null;
  }
  return node ?? null;
}

/** Body fields where WE choose the ID on a create / bulk-create operation. */
function ownIds(op, resources) {
  const out = new Set();
  for (const d of Object.values(resources)) {
    if (d.create_op === op.operation_id && d.id_path.split('.')[0] in (d.body || {})) out.add(fieldKey('body', d.id_path.split('.')));
    for (const a of d.also_created_by) {
      // only the first list element is ever mutated (iterFields walks element 0)
      if (a.operation === op.operation_id) out.add(fieldKey('body', a.id_path.split('.').map((x) => (x === '*' ? 0 : x))));
    }
  }
  return out;
}

function stringIds(op, bindings, own) {
  const out = new Set();
  const body = op.body ? op.body.json_schema : null;
  for (const b of bindings) {
    let sch;
    if (b.location === 'body') sch = schemaAt(body, b.path);
    else {
      const p = op.parameters.find((x) => x.name === b.path[0] && x.location === b.location);
      sch = p ? p.schema : null;
    }
    if (sch && sch.effective_type === 'string') out.add(fieldKey(b.location, b.path));
  }
  for (const key of own) {
    const i = key.indexOf('|');
    const sch = schemaAt(body, JSON.parse(key.slice(i + 1)));
    if (sch && sch.effective_type === 'string') out.add(key);
  }
  return out;
}

export function buildPlan(api, target, profile, {
  level, runId, seed, filters = null, includeExports = false, overrides = null, resources = null, valueCtx = null, rules = null, allowInjection = false,
}) {
  if (!LEVELS.includes(level)) throw new Error(`level must be one of ${LEVELS.join(', ')}`);
  filters = filters || new Filters();
  resources = resources || {};
  const ctx = valueCtx || new ValueContext(runId, seed, target.timezone_offset);
  const bindings = inferBindings(api, resources);
  const builder = new BaselineBuilder(target, ctx, overrides, bindings, resources);
  const generators = REGISTRY.map((Cls) => new Cls());
  const maxRank = LEVEL_RANK[level];
  rules = rules === null ? loadRules(target.rules) : rules;
  const pathMethods = new Map();
  for (const op of api.operations) {
    if (!pathMethods.has(op.path)) pathMethods.set(op.path, new Set());
    pathMethods.get(op.path).add(op.method);
  }
  const seenPaths = new Set();

  const plan = new Plan({ target, level, ops: [] });
  plan.filter_warnings = filters.unmatched(api.operations);
  plan.filters_used = filters.toDict();
  for (const op of api.operations) {
    if (!filters.match(op)) {
      plan.filtered_out += 1;
      continue;
    }
    if (op.is_export && !includeExports) {
      plan.excluded_exports += 1;
      continue;
    }
    const decision = detectAuth(op, target.auth);
    const baseline = builder.build(op);
    const opBindings = bindings[op.operation_id] || [];
    const own = ownIds(op, resources);
    const skip = op.unsupportedReason() || ownershipSkipReason(op, opBindings, profile);
    const gctx = new GenContext({
      target, op, baseline, auth: decision, reject_codes: target.expectations.rejectCodes(op.operation_id, op.tags),
      bindings: opBindings, own_resources_only: profile.own_resources_only, own_id_fields: own,
      string_id_fields: stringIds(op, opBindings, own), value_ctx: ctx, rules, path_methods: pathMethods.get(op.path),
      first_on_path: !skip && !seenPaths.has(op.path), first_op: !skip && !plan.ops_with_cases, findings: plan.findings,
      allow_injection: allowInjection && profile.allow_injection,
    });
    if (!skip) seenPaths.add(op.path);
    const cases = [];
    const seen = new Set();
    for (const gen of generators) {
      if (skip && gen.technique !== 'BASE') continue;
      for (const c of gen.generate(gctx)) {
        if (LEVEL_RANK[c.level] <= maxRank && !seen.has(c.id)) {
          seen.add(c.id);
          cases.push(c);
        }
      }
    }
    for (const f of builder.findings) if (!plan.findings.some((x) => x.kind === f.kind && x.message === f.message && x.operations.join() === f.operations.join())) plan.findings.push(f);
    builder.findings.length = 0;
    plan.ops.push(new OpPlan(op, decision, baseline, cases, opBindings, skip));
    if (!skip) plan.ops_with_cases += 1;
  }
  return plan;
}
