// `apitest analyze`: Step-0 style statistics + spec-quality findings. Pure function over the model.
import { detectAuth } from '../auth/detect.js';
import { Counter, sorted } from '../util/py.js';
import { CONSTRAINT_KEYS, MISSING, Schema } from './model.js';

export const KEYWORDS = Object.freeze(['required', 'enum', 'format', ...CONSTRAINT_KEYS, 'example', 'default']);
const ID_FIELD = /(^id$|Id$|_id$|Ids$|_ids$)/;
const DESC_RULE = /(above|below|greater than|less than|at most|at least|must not exceed|not exceed|maximum|minimum|en fazla|en az|fazla olmamal|olmamalıdır|büyük olamaz|küçük olamaz)/i;
const PLACEHOLDER = /\$\{[^}]+\}/g;
const isError = (c) => c.startsWith('4') || c.startsWith('5') || c === 'default';

export class DocFinding {
  constructor(kind, message, operations = []) {
    this.kind = kind; // placeholder | duplicate_summary | missing_description | description_rule | ...
    this.message = message;
    this.operations = operations;
  }
}

function walk(schema, visit, seen) {
  if (seen.has(schema)) return;
  seen.add(schema);
  visit(schema);
  for (const sub of Object.values(schema.properties)) walk(sub, visit, seen);
  if (schema.items !== null) walk(schema.items, visit, seen);
  if (schema.additional_properties instanceof Schema) walk(schema.additional_properties, visit, seen);
  for (const alt of schema.one_of) walk(alt, visit, seen);
}

export function analyze(api, auth = null) {
  const ops = api.operations;
  const kw = new Counter();
  const formats = new Counter();

  const count = (s) => {
    kw.add('required', s.required.size);
    if (s.enum !== null) kw.add('enum');
    if (s.format) {
      kw.add('format');
      formats.add(`${s.effective_type}/${s.format}`);
    }
    for (const k of CONSTRAINT_KEYS) if (k in s.constraints) kw.add(k);
    if (s.example !== MISSING) kw.add('example');
    if (s.default !== MISSING) kw.add('default');
  };

  // every distinct schema object reachable from named schemas, parameters and bodies, counted once
  const seen = new Set();
  for (const s of Object.values(api.schemas)) walk(s, count, seen);
  const paramLoc = new Counter();
  const pathParams = new Counter();
  for (const op of ops) {
    for (const p of op.parameters) {
      paramLoc.add(p.location);
      if (p.required) kw.add('required');
      if (p.location === 'path') pathParams.add(`${p.name} (${p.schema.effective_type}${p.schema.format ? '/' + p.schema.format : ''})`);
      walk(p.schema, count, seen);
    }
    if (op.body) for (const sch of Object.values(op.body.schemas)) walk(sch, count, seen);
  }

  const reqCt = new Counter();
  for (const op of ops) if (op.body) for (const ct of op.body.content_types) reqCt.add(ct);

  const idFields = new Counter();
  for (const s of Object.values(api.schemas)) for (const name of Object.keys(s.properties)) if (ID_FIELD.test(name)) idFields.add(name);

  const codes = new Counter();
  const withSchema = new Counter();
  for (const op of ops) {
    for (const [code, r] of Object.entries(op.responses)) {
      codes.add(code);
      if (r.schema !== null) withSchema.add(code);
    }
  }

  let authNeeded = 0;
  const reasons = new Counter();
  if (auth && auth.header) {
    for (const op of ops) {
      const d = detectAuth(op, auth);
      authNeeded += d.needs ? 1 : 0;
      reasons.add(d.reason);
    }
  }

  const unsupported = {};
  for (const op of ops) {
    const r = op.unsupportedReason();
    if (r) unsupported[op.operation_id] = r;
  }
  const securitySchemes = {};
  for (const [n, s] of Object.entries(api.security_schemes)) securitySchemes[n] = `${s.type}` + (s.location ? ` (${s.location} '${s.param_name}')` : '');

  return {
    title: api.title,
    spec_version: api.spec_version,
    servers: api.servers,
    operation_count: ops.length,
    path_count: new Set(ops.map((op) => op.path)).size,
    by_method: Counter.of(ops.map((op) => op.method)).toObject(Counter.of(ops.map((op) => op.method)).mostCommon()),
    by_tag: (() => { const c = Counter.of(ops.flatMap((op) => (op.tags.length ? op.tags : ['<untagged>']))); return c.toObject(c.mostCommon()); })(),
    schema_count: Object.keys(api.schemas).length,
    security_schemes: securitySchemes,
    auth_header: auth ? auth.header : null,
    auth_needed: authNeeded,
    auth_not_needed: auth && auth.header ? ops.length - authNeeded : 0,
    auth_reasons: reasons.toObject(reasons.mostCommon()),
    keyword_counts: Object.fromEntries(KEYWORDS.map((k) => [k, kw.getn(k)])),
    formats: formats.toObject(formats.mostCommon()),
    request_content_types: reqCt.toObject(reqCt.mostCommon()),
    param_locations: paramLoc.toObject(paramLoc.mostCommon()),
    path_params: pathParams.toObject(pathParams.mostCommon()),
    id_fields: idFields.toObject(idFields.mostCommon(15)),
    response_codes: codes.toObject(sorted([...codes.entries()], (e) => e[0])),
    responses_with_schema: withSchema.toObject(sorted([...withSchema.entries()], (e) => e[0])),
    export_operations: ops.filter((op) => op.is_export).length,
    unsupported_operations: unsupported,
    findings: specFindings(api),
  };
}

export function specFindings(api) {
  const out = [];
  const ops = api.operations;
  for (const op of ops) {
    for (const [label, text] of [['summary', op.summary], ['description', op.description]]) {
      for (const m of (text || '').match(PLACEHOLDER) || []) out.push(new DocFinding('placeholder', `unrendered placeholder ${m} in ${label}`, [op.operation_id]));
    }
  }
  const bySummary = new Map();
  for (const op of ops) {
    if (op.summary) {
      const k = op.summary.trim();
      if (!bySummary.has(k)) bySummary.set(k, []);
      bySummary.get(k).push(op.operation_id);
    }
  }
  for (const [summary, ids] of bySummary) {
    if (ids.length > 1) out.push(new DocFinding('duplicate_summary', `summary used by ${ids.length} operations: "${summary}"`, ids));
  }
  const missing = ops.filter((op) => !op.summary && !op.description).map((op) => op.operation_id);
  if (missing.length) out.push(new DocFinding('missing_description', `${missing.length} operation(s) without summary and description`, missing));
  const noErr = ops.filter((op) => !Object.keys(op.responses).some(isError)).map((op) => op.operation_id);
  if (noErr.length) out.push(new DocFinding('no_error_responses', `${noErr.length} operation(s) document no 4xx/5xx/default response`, noErr));
  const errNoSchema = ops.filter((op) => Object.entries(op.responses).some(([c, r]) => isError(c) && r.schema === null)).map((op) => op.operation_id);
  if (errNoSchema.length) out.push(new DocFinding('error_without_schema', `${errNoSchema.length} operation(s) have error responses without a body schema`, errNoSchema));
  const exports = ops.filter((op) => {
    const r = op.responses['200'];
    return op.is_export && r && r.schema !== null && r.schema.ref_name === 'ModelAndView';
  }).map((op) => op.operation_id);
  if (exports.length) out.push(new DocFinding('export_not_file', `${exports.length} export operation(s) declare a ModelAndView JSON schema instead of a file response`, exports));
  for (const op of ops) {
    const texts = [[op.description || '', 'operation'], ...op.parameters.map((p) => [p.description || '', p.label])];
    for (const [text, where] of texts) {
      if (DESC_RULE.test(text) && /\d/.test(text)) out.push(new DocFinding('description_rule', `rule only in description text (${where}): ${text.trim().slice(0, 200)}`, [op.operation_id]));
    }
  }
  for (const [name, s] of Object.entries(api.schemas)) {
    for (const [fieldName, fs] of Object.entries(s.properties)) {
      const d = fs.description || '';
      if (DESC_RULE.test(d) && /\d/.test(d)) out.push(new DocFinding('description_rule', `rule only in description text (${name}.${fieldName}): ${d.trim().slice(0, 200)}`));
    }
  }
  return out;
}

const pad = (n, w) => String(n).padStart(w);
const join = (obj, sep = ' ') => Object.entries(obj).map(([k, v]) => `${k}${sep}${v}`).join(', ');

export function formatAnalysis(a) {
  const lines = [
    `${a.title}  —  spec ${a.spec_version}`,
    `servers: ${a.servers.join(', ') || '(none)'}`,
    `operations: ${a.operation_count}   paths: ${a.path_count}   schemas: ${a.schema_count}   export ops: ${a.export_operations}`,
    'by method: ' + join(a.by_method),
    `tags (${Object.keys(a.by_tag).length}):`,
    ...Object.entries(a.by_tag).map(([k, v]) => `  ${pad(v, 4)}  ${k}`),
    'security schemes: ' + (join(a.security_schemes, ': ') || 'none'),
  ];
  if (a.auth_header) {
    lines.push(`auth header '${a.auth_header}': needed by ${a.auth_needed} ops, not needed by ${a.auth_not_needed}`);
    for (const [k, v] of Object.entries(a.auth_reasons)) lines.push(`  ${pad(v, 4)}  ${k}`);
  }
  lines.push(
    'constraint keywords: ' + join(a.keyword_counts),
    'formats: ' + join(a.formats),
    'request content types: ' + join(a.request_content_types),
    'parameter locations: ' + join(a.param_locations),
    'path params: ' + (join(a.path_params, ' ×') || 'none'),
    'ID-like fields: ' + join(a.id_fields),
    'response codes: ' + join(a.response_codes, ': '),
    'responses with schema: ' + join(a.responses_with_schema, ': '),
  );
  if (Object.keys(a.unsupported_operations).length) {
    lines.push('not supported yet: ' + Object.entries(a.unsupported_operations).map(([k, v]) => `${k} (${v})`).join(', '));
  }
  lines.push(`documentation findings (${a.findings.length}):`);
  const byKind = Counter.of(a.findings.map((f) => f.kind));
  for (const [kind, n] of byKind) {
    lines.push(`  ${kind}: ${n}`);
    for (const f of a.findings.filter((x) => x.kind === kind).slice(0, 5)) {
      lines.push(`    - ${f.message.slice(0, 160)}` + (f.operations.length ? `  [${f.operations.slice(0, 3).join(', ')}${f.operations.length > 3 ? '…' : ''}]` : ''));
    }
  }
  return lines.join('\n');
}
