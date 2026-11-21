// Version-independent endpoint model. Nothing after the normalizer knows Swagger 2.0 vs OpenAPI 3.x.

/** Sentinel for 'no example/default given' (null is a legitimate example value). */
export const MISSING = Object.freeze({ repr: () => 'MISSING', toString: () => 'MISSING' });

export const CONSTRAINT_KEYS = Object.freeze([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems',
]);

/** A schema node. Named ($ref) schemas are shared objects, so the graph may contain cycles:
 *  every walker must use a depth limit or a visited set. */
export class Schema {
  constructor(init = {}) {
    this.type = null;
    this.format = null;
    this.enum = null;
    this.properties = {};
    this.required = new Set();
    this.items = null;
    this.nullable = false;
    this.read_only = false;
    this.write_only = false;
    this.constraints = {};
    this.example = MISSING;
    this.default = MISSING;
    this.description = null;
    this.ref_name = null;
    this.additional_properties = null; // null / boolean / Schema
    this.one_of = []; // oneOf/anyOf alternatives
    Object.assign(this, init);
  }

  get effective_type() {
    if (this.type) return this.type;
    if (Object.keys(this.properties).length) return 'object';
    if (this.items !== null) return 'array';
    return null;
  }

  repr() {
    return `<Schema${this.ref_name ? ' ' + this.ref_name : ''} type=${this.effective_type} format=${this.format}>`;
  }
}

export class Parameter {
  constructor(name, location, required, schema, description = null, explode = true, collection_format = null) {
    Object.assign(this, { name, location, required, schema, description, explode, collection_format });
  }

  get label() {
    return `${this.location}.${this.name}`;
  }
}

const base = (ct) => ct.split(';')[0].trim().toLowerCase();

export class RequestBody {
  constructor(required, content_types, schemas, description = null) {
    Object.assign(this, { required, content_types, schemas, description });
  }

  jsonContentType() {
    for (const ct of this.content_types) {
      const b = base(ct);
      if (b === 'application/json' || b.endsWith('+json')) return ct;
    }
    return null;
  }

  get json_schema() {
    const ct = this.jsonContentType();
    return ct ? this.schemas[ct] ?? null : null;
  }

  /** [content type, encoding] the tool sends. JSON whenever the operation accepts it (decision: JSON
   *  bodies); otherwise form-urlencoded, multipart, or a raw binary body. */
  choose() {
    const ct = this.jsonContentType();
    if (ct) return [ct, 'json'];
    for (const c of this.content_types) if (base(c) === 'application/x-www-form-urlencoded') return [c, 'form'];
    for (const c of this.content_types) if (base(c) === 'multipart/form-data') return [c, 'multipart'];
    for (const c of this.content_types) {
      const b = base(c);
      if (b === 'application/octet-stream' || b.startsWith('image/') || b.startsWith('audio/') || b.startsWith('video/') || b === 'application/pdf') return [c, 'binary'];
    }
    return null;
  }

  get chosen_schema() {
    const ch = this.choose();
    return ch ? this.schemas[ch[0]] ?? null : null;
  }
}

export class ResponseSpec {
  constructor(code, description, content_types, schema) {
    Object.assign(this, { code, description, content_types, schema });
  }
}

export class Operation {
  constructor(init) {
    this.deprecated = false;
    this.is_export = false;
    Object.assign(this, init); // operation_id, method, path, tags, summary, description, parameters, body, responses, security
  }

  get key() {
    return `${this.method} ${this.path}`;
  }

  params(location) {
    return this.parameters.filter((p) => p.location === location);
  }

  /** Bodies the tool can build: JSON, form-urlencoded, multipart, binary. Others (e.g. XML-only: out of
   *  scope by decision) make a required body unsendable. */
  unsupportedReason() {
    if (this.body && this.body.required && this.body.choose() === null) {
      return `request body type ${this.body.content_types.join(', ')} is not supported (JSON/form/multipart/binary only)`;
    }
    return null;
  }
}

export class SecurityScheme {
  constructor(name, type, location, param_name) {
    Object.assign(this, { name, type, location, param_name });
  }
}

export class ApiSpec {
  constructor(init) {
    Object.assign(this, init); // title, spec_version, servers, operations, schemas, security_schemes, raw, source, sha256
  }

  get is_swagger2() {
    return this.spec_version.startsWith('2');
  }

  operation(operationId) {
    const op = this.findOperation(operationId);
    if (!op) throw new Error(`operationId not found in spec: ${operationId}`);
    return op;
  }

  findOperation(operationId) {
    return this.operations.find((op) => op.operation_id === operationId) || null;
  }
}
