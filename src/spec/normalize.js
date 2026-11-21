// Swagger 2.0 / OpenAPI 3.x -> endpoint model (spec/model.js).
//
// $ref handling: local refs (#/...) are resolved lazily and cached, so each named schema becomes ONE
// shared Schema object; recursive schemas therefore become cycles in the object graph, not infinite
// recursion. External file refs are not supported yet and raise a clear error.
import { pyRegex } from '../util/py.js';
import { SpecLoadError } from './loader.js';
import {
  ApiSpec, CONSTRAINT_KEYS, MISSING, Operation, Parameter, RequestBody, ResponseSpec, Schema, SecurityScheme,
} from './model.js';

export const HTTP_METHODS = Object.freeze(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);

export class RefResolver {
  constructor(root) {
    this.root = root;
  }

  resolve(ref) {
    if (!ref.startsWith('#/')) throw new SpecLoadError(`external $ref not supported yet: ${ref}`);
    let node = this.root;
    for (let part of ref.slice(2).split('/')) {
      part = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!has(node, part)) throw new SpecLoadError(`unresolvable $ref: ${ref}`);
      node = node[part];
    }
    return node;
  }

  /** Follow $ref chains for non-schema objects (parameters, responses, request bodies). */
  deref(node) {
    let seen = 0;
    while (has(node, '$ref')) {
      node = this.resolve(node.$ref);
      seen += 1;
      if (seen > 50) throw new SpecLoadError('$ref chain too long (cycle?)');
    }
    return node;
  }
}

export class SchemaBuilder {
  constructor(resolver, swagger2) {
    this.resolver = resolver;
    this.swagger2 = swagger2;
    this.cache = new Map();
  }

  build(node) {
    if (!isObj(node)) return new Schema();
    if (has(node, '$ref')) {
      const ref = node.$ref;
      if (this.cache.has(ref)) return this.cache.get(ref);
      const schema = new Schema({ ref_name: ref.split('/').pop() });
      this.cache.set(ref, schema); // register before filling: makes cycles safe
      this.fill(schema, this.resolver.resolve(ref));
      return schema;
    }
    const schema = new Schema();
    this.fill(schema, node);
    return schema;
  }

  fill(s, node) {
    if (!isObj(node)) return;
    for (const part of node.allOf || []) SchemaBuilder.merge(s, this.build(part));
    let t = node.type;
    if (Array.isArray(t)) { // OAS 3.1 style ["string", "null"]
      const nonNull = t.filter((x) => x !== 'null');
      s.nullable = s.nullable || t.includes('null');
      t = nonNull.length ? nonNull[0] : null;
    }
    if (t) s.type = t;
    if (has(node, 'format')) s.format = node.format;
    if (has(node, 'enum')) s.enum = [...(node.enum || [])];
    for (const key of CONSTRAINT_KEYS) if (has(node, key)) s.constraints[key] = node[key];
    if (has(node, 'example')) s.example = node.example;
    else if (Array.isArray(node.examples) && node.examples.length) s.example = node.examples[0];
    if (has(node, 'default')) s.default = node.default;
    if (node.nullable || node['x-nullable']) s.nullable = true;
    if (node.readOnly) s.read_only = true;
    if (node.writeOnly) s.write_only = true;
    if (node.description) s.description = node.description;
    for (const [name, sub] of Object.entries(node.properties || {})) s.properties[name] = this.build(sub);
    if (Array.isArray(node.required)) for (const r of node.required) s.required.add(r);
    if (has(node, 'items')) s.items = this.build(node.items);
    const ap = node.additionalProperties;
    if (isObj(ap)) s.additional_properties = this.build(ap);
    else if (typeof ap === 'boolean') s.additional_properties = ap;
    for (const key of ['oneOf', 'anyOf']) for (const alt of node[key] || []) s.one_of.push(this.build(alt));
  }

  static merge(target, part) {
    target.type = target.type || part.type;
    target.format = target.format || part.format;
    if (part.enum && part.enum.length && !(target.enum && target.enum.length)) target.enum = [...part.enum];
    for (const [k, v] of Object.entries(part.properties)) if (!(k in target.properties)) target.properties[k] = v;
    for (const r of part.required) target.required.add(r);
    target.constraints = { ...part.constraints, ...target.constraints };
    if (target.example === MISSING) target.example = part.example;
    if (target.default === MISSING) target.default = part.default;
    target.items = target.items || part.items;
    target.description = target.description || part.description;
  }
}

const V2_PARAM_KEYS = new Set(['type', 'format', 'items', 'enum', 'default', 'example', 'x-example', ...CONSTRAINT_KEYS]);

function paramSchemaV2(builder, p) {
  // Swagger 2.0 non-body params carry the schema keywords on the parameter itself.
  const node = {};
  for (const [k, v] of Object.entries(p)) if (V2_PARAM_KEYS.has(k)) node[k] = v;
  if ('x-example' in node && !('example' in node)) {
    node.example = node['x-example'];
    delete node['x-example'];
  }
  return builder.build(node);
}

function opId(method, path) {
  return method.toLowerCase() + '_' + (path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root');
}

export function normalize(loaded, exportTagPattern = null) {
  const raw = loaded.raw;
  const swagger2 = 'swagger' in raw;
  const version = String(raw.swagger ?? raw.openapi);
  const resolver = new RefResolver(raw);
  const builder = new SchemaBuilder(resolver, swagger2);
  const exportRe = exportTagPattern ? pyRegex(exportTagPattern) : null;

  // named schemas (so analyze can count them even if unused)
  const defs = swagger2 ? raw.definitions : (raw.components || {}).schemas;
  const prefix = swagger2 ? '#/definitions/' : '#/components/schemas/';
  const schemas = {};
  for (const name of Object.keys(defs || {})) schemas[name] = builder.build({ $ref: prefix + name.replace(/~/g, '~0').replace(/\//g, '~1') });

  const secDefs = swagger2 ? raw.securityDefinitions : (raw.components || {}).securitySchemes;
  const securitySchemes = {};
  for (const [name, sdRaw] of Object.entries(secDefs || {})) {
    const sd = resolver.deref(sdRaw);
    securitySchemes[name] = new SecurityScheme(name, sd.type ?? '', sd.in ?? null, sd.name ?? null);
  }

  const globalSecurity = raw.security;
  const globalConsumes = raw.consumes || [];
  const globalProduces = raw.produces || [];
  const operations = [];
  const usedIds = new Set();

  for (const [path, itemRaw] of Object.entries(raw.paths || {})) {
    const item = resolver.deref(itemRaw);
    const common = item.parameters || [];
    for (const method of HTTP_METHODS) {
      if (!has(item, method)) continue;
      const op = item[method];
      const merged = new Map();
      for (const pr of [...common, ...(op.parameters || [])]) {
        const p = resolver.deref(pr);
        merged.set(`${p.name}\u0000${p.in}`, p);
      }

      const params = [];
      let body = null;
      const formFields = new Map();
      for (const p of merged.values()) {
        const name = p.name;
        const loc = p.in;
        if (swagger2 && loc === 'body') {
          const consumes = op.consumes || (globalConsumes.length ? globalConsumes : ['application/json']);
          const sch = builder.build(p.schema || {});
          body = new RequestBody(Boolean(p.required), [...consumes], Object.fromEntries(consumes.map((ct) => [ct, sch])), p.description ?? null);
        } else if (swagger2 && loc === 'formData') {
          formFields.set(name, p);
        } else {
          let sch;
          let explode;
          let cf;
          if (swagger2) {
            sch = paramSchemaV2(builder, p);
            explode = p.collectionFormat === 'multi';
            cf = sch.effective_type === 'array' ? p.collectionFormat ?? 'csv' : null;
          } else {
            sch = builder.build(p.schema || {});
            if (has(p, 'example') && sch.example === MISSING) sch.example = p.example;
            explode = has(p, 'explode') ? p.explode : (p.style ?? 'form') === 'form';
            cf = null;
          }
          params.push(new Parameter(name, loc, Boolean(p.required) || loc === 'path', sch, p.description ?? null, explode, cf));
        }
      }
      if (swagger2 && formFields.size) {
        const consumes = op.consumes || (globalConsumes.length ? globalConsumes : ['application/x-www-form-urlencoded']);
        const formSchema = new Schema({ type: 'object' });
        for (const [name, p] of formFields) {
          formSchema.properties[name] = paramSchemaV2(builder, p);
          if (p.required) formSchema.required.add(name);
        }
        body = new RequestBody(formSchema.required.size > 0, [...consumes], Object.fromEntries(consumes.map((ct) => [ct, formSchema])));
      }
      if (!swagger2 && has(op, 'requestBody')) {
        const rb = resolver.deref(op.requestBody);
        const content = rb.content || {};
        const sch = {};
        for (const [ct, m] of Object.entries(content)) sch[ct] = builder.build((m && m.schema) || {});
        body = new RequestBody(Boolean(rb.required), Object.keys(content), sch, rb.description ?? null);
      }

      const responses = {};
      const produces = op.produces || globalProduces;
      for (const [code, rr] of Object.entries(op.responses || {})) {
        const r = resolver.deref(rr);
        let sch;
        let cts;
        if (swagger2) {
          sch = has(r, 'schema') ? builder.build(r.schema) : null;
          cts = sch !== null || produces.length ? [...produces] : [];
        } else {
          const content = r.content || {};
          cts = Object.keys(content);
          let chosen = Object.entries(content).find(([ct, m]) => ct.includes('json') && has(m, 'schema'))?.[1] || null;
          chosen = chosen || Object.values(content).find((m) => has(m, 'schema')) || null;
          sch = chosen ? builder.build(chosen.schema) : null;
        }
        responses[String(code)] = new ResponseSpec(String(code), r.description ?? null, cts, sch);
      }

      const sec = (has(op, 'security') ? op.security : globalSecurity) || [];
      const security = sec.filter((alt) => isObj(alt)).map((alt) => Object.keys(alt).sort());
      const tags = [...(op.tags || [])];
      let id = op.operationId || opId(method, path);
      if (usedIds.has(id)) id = `${id}_${opId(method, path)}`; // duplicate operationIds would break overrides/known-issues
      usedIds.add(id);
      operations.push(new Operation({
        operation_id: id,
        method: method.toUpperCase(),
        path,
        tags,
        summary: op.summary ?? null,
        description: op.description ?? null,
        parameters: params,
        body,
        responses,
        security,
        deprecated: Boolean(op.deprecated),
        is_export: Boolean(exportRe && tags.some((t) => exportRe.test(t))),
      }));
    }
  }

  return new ApiSpec({
    title: (raw.info || {}).title ?? '',
    spec_version: version,
    servers: servers(raw, swagger2, loaded.url),
    operations,
    schemas,
    security_schemes: securitySchemes,
    raw,
    source: loaded.source,
    sha256: loaded.sha256,
  });
}

function servers(raw, swagger2, sourceUrl) {
  if (swagger2) {
    const host = raw.host;
    const base = raw.basePath || '';
    if (!host) {
      if (sourceUrl) {
        const u = new URL(sourceUrl);
        return [`${u.protocol}//${u.host}${base}`.replace(/\/+$/, '')];
      }
      return base ? [base] : [];
    }
    const schemes = raw.schemes || (sourceUrl ? [new URL(sourceUrl).protocol.replace(':', '')] : ['https']);
    const ordered = [...schemes].sort((a, b) => (a === 'https' ? 0 : 1) - (b === 'https' ? 0 : 1));
    return ordered.map((s) => `${s}://${host}${base}`.replace(/\/+$/, ''));
  }
  const out = [];
  for (const srv of raw.servers || []) {
    let url = srv.url ?? '';
    for (const [v, spec] of Object.entries(srv.variables || {})) url = url.split('{' + v + '}').join(String(spec.default ?? ''));
    if (!url.includes('://') && sourceUrl) url = new URL(url, sourceUrl).toString();
    out.push(url.replace(/\/+$/, ''));
  }
  return out;
}
