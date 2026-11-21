// Request template: the valid baseline request of an operation, before resource IDs are resolved.
// Test cases are this template + exactly one Mutation.
import zlib from 'node:zlib';
import { crc32 } from '../util/binary.js';
import { isPlainObject } from '../util/json.js';
import { deepCopy } from '../util/py.js';

class Sentinel {
  constructor(name) {
    this.name = name;
    Object.freeze(this);
  }

  repr() {
    return `<${this.name}>`;
  }

  toString() {
    return this.repr();
  }
}

export const NO_BODY = new Sentinel('no body');
export const OMIT = new Sentinel('omit');

/** A valid 1x1 transparent PNG (tiny upload payload, never real data). */
function png1x1() {
  const chunk = (kind, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const kd = Buffer.concat([Buffer.from(kind, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(kd));
    return Buffer.concat([len, kd, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]); // 1x1, 8-bit RGBA
  const idat = zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0])); // filter byte + one transparent pixel
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

export const SAMPLE_PNG = png1x1();

/** A file sent in a multipart part or as a binary body. */
export class FileValue {
  constructor(filename = 'apitest.png', content_type = 'image/png', data = SAMPLE_PNG) {
    this.filename = filename;
    this.content_type = content_type;
    this.data = Buffer.isBuffer(data) ? data : Buffer.from(data);
    Object.freeze(this);
  }

  repr() {
    return `<file ${this.filename} ${this.data.length} bytes ${this.content_type}>`;
  }

  equals(o) {
    return o instanceof FileValue && o.filename === this.filename && o.content_type === this.content_type && o.data.equals(this.data);
  }
}

/** Placeholder for an ID of a resource created by this run, resolved at execution time. */
export class ResourceRef {
  constructor(kind, purpose = 'read', field = 'id') {
    this.kind = kind;
    this.purpose = purpose; // read | mutate | consume
    this.field = field;
    Object.freeze(this);
  }

  repr() {
    return `<${this.kind}.${this.field}:${this.purpose}>`;
  }

  equals(o) {
    return o instanceof ResourceRef && o.kind === this.kind && o.purpose === this.purpose && o.field === this.field;
  }
}

export class FieldRef {
  constructor(location, path = []) {
    this.location = location; // path | query | header | body
    this.path = Object.freeze([...path]); // body: keys / list indices; params: [name]
    Object.freeze(this);
  }

  get label() {
    let out = this.location;
    for (const part of this.path) out += typeof part === 'number' ? `[${part}]` : `.${part}`;
    return out;
  }
}

const isContainer = (v) => Array.isArray(v) || isPlainObject(v);
const hasPart = (node, part) => (Array.isArray(node) ? typeof part === 'number' && part >= 0 && part < node.length : isPlainObject(node) && Object.prototype.hasOwnProperty.call(node, part));

export class RequestTemplate {
  constructor() {
    this.path = {};
    this.query = {};
    this.headers = {};
    this.body = NO_BODY;
    this.content_type = null;
    this.encoding = 'json'; // json | form | multipart | binary
  }

  copy() {
    const t = new RequestTemplate();
    t.path = deepCopy(this.path);
    t.query = deepCopy(this.query);
    t.headers = deepCopy(this.headers);
    t.body = deepCopy(this.body);
    t.content_type = this.content_type;
    t.encoding = this.encoding;
    return t;
  }

  section(location) {
    const s = { path: this.path, query: this.query, header: this.headers }[location];
    if (!s) throw new Error(`unknown parameter location ${location}`);
    return s;
  }

  /** Current value at ref; OMIT if it is not there. */
  get(ref) {
    if (ref.location === 'body') {
      let node = this.body;
      for (const part of ref.path) {
        if (!hasPart(node, part)) return OMIT;
        node = node[part];
      }
      return node;
    }
    const sec = this.section(ref.location);
    return Object.prototype.hasOwnProperty.call(sec, ref.path[0]) ? sec[ref.path[0]] : OMIT;
  }

  set(ref, value) {
    if (ref.location === 'body') {
      if (!ref.path.length) {
        this.body = value === OMIT ? NO_BODY : value;
        return;
      }
      let node = this.body;
      for (const part of ref.path.slice(0, -1)) {
        if (!isContainer(node) || !hasPart(node, part)) throw new Error(`no body field at ${ref.label}`);
        node = node[part];
      }
      const last = ref.path[ref.path.length - 1];
      if (value === OMIT) {
        if (isPlainObject(node)) delete node[last];
        else if (Array.isArray(node) && typeof last === 'number' && last < node.length) node.splice(last, 1);
      } else {
        node[last] = value;
      }
      return;
    }
    const sec = this.section(ref.location);
    if (value === OMIT) delete sec[ref.path[0]];
    else sec[ref.path[0]] = value;
  }

  resourceRefs() {
    const found = [];
    const walk = (v) => {
      if (v instanceof ResourceRef) found.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (isPlainObject(v)) Object.values(v).forEach(walk);
    };
    [this.path, this.query, this.headers, this.body].forEach(walk);
    return found;
  }
}

/** Return a copy of value with every ResourceRef replaced by await resolve(ref). */
export async function replaceRefs(value, resolve) {
  if (value instanceof ResourceRef) return resolve(value);
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) out.push(await replaceRefs(v, resolve));
    return out;
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await replaceRefs(v, resolve);
    return out;
  }
  return value;
}

/** JSON-friendly representation for reports / dry-run CSV. */
export function toDisplay(value) {
  if (value === NO_BODY || value === OMIT || value instanceof ResourceRef || value instanceof FileValue) return value.repr();
  if (Array.isArray(value)) return value.map(toDisplay);
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toDisplay(v);
    return out;
  }
  return value;
}
