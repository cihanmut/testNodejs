// In-memory fake of the Petstore v3 pet/store/user endpoints, used as the HTTP transport (offline), plus a
// fake export API. Same behaviour as the Python test fakes.
import { dumps, isPlainObject, normInt, parseJson } from '../src/util/json.js';
import { parseQsl } from '../src/util/url.js';

export const PREFIX = '/api/v3';
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

export const json = (status, obj, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(dumps(obj)) });
export const text = (status, s = '', headers = {}) => ({ status, headers: { 'content-type': 'text/plain', ...headers }, body: Buffer.from(s) });
const isInt = (v) => typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v));
const inInt64 = (v) => BigInt(v) >= INT64_MIN && BigInt(v) <= INT64_MAX;
const key = (id) => String(id);

/** A received request with case-insensitive headers (like httpx.Request in the Python tests). */
export class FakeRequest {
  constructor({ method, url, headers, body }) {
    this.method = method;
    this.url = new URL(url);
    this.headers = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    this.content = body || Buffer.alloc(0);
  }

  header(name) {
    return this.headers[name.toLowerCase()];
  }
}

export class FakePetstore {
  constructor({ requireAuth = true, apiKey = 'special-key', strict = true, unhealthy = false, expireAfterAuth = null, failCreate = false, coerceIds = false, prefix = PREFIX } = {}) {
    this.prefix = prefix; // "/api/v3" (OAS3 Petstore) or "/v2" (Swagger 2.0 Petstore)
    this.uploads = [];
    this.pets = new Map();
    this.require_auth = requireAuth;
    this.api_key = apiKey;
    this.strict = strict;
    this.unhealthy = unhealthy;
    this.expire_after_auth = expireAfterAuth;
    this.fail_create = failCreate;
    this.coerce_ids = coerceIds; // like Jackson: 1.5 -> 1, true -> 1
    this.auth_ok_count = 0;
    this.requests = [];
    this.ever_created = new Set();
    // store / user. Orders 11..20 already exist and belong to "other users".
    this.orders = new Map();
    for (let i = 11; i <= 20; i++) this.orders.set(key(i), { id: i, petId: 1, status: 'placed' });
    this.foreign_orders = new Set(this.orders.keys());
    this.users = new Map([['theUser', { username: 'theUser', id: 1 }]]);
    this.handle = this.handle.bind(this);
  }

  transport() {
    return async (req) => this.handle(new FakeRequest(req));
  }

  handle(request) {
    this.requests.push(request);
    if (this.unhealthy) return text(503, 'maintenance');
    let path = request.url.pathname;
    if (!path.startsWith(this.prefix)) return text(404);
    path = path.slice(this.prefix.length);
    const m = request.method;
    if (path.startsWith('/store') || path.startsWith('/user')) return this.storeUser(request, path, m);
    if (path === '/pet' && (m === 'POST' || m === 'PUT')) return this.upsert(request, m === 'POST');
    if (path === '/pet/findByStatus' && m === 'GET') {
      const status = request.url.searchParams.get('status');
      if (!['available', 'pending', 'sold'].includes(status)) return json(400, { code: 400, message: 'Input error: query parameter `status value `' + status + '` is not in the allowable values `[available, pending, sold]`' });
      return json(200, [...this.pets.values()].filter((p) => p.status === status));
    }
    if (path === '/pet/findByTags' && m === 'GET') {
      if (!request.url.searchParams.getAll('tags').length) return json(400, { code: 400, message: 'No tags provided' });
      return json(200, []);
    }
    const mo = /^\/pet\/([^/]*)(\/uploadImage)?$/.exec(path);
    if (mo) {
      const rawId = decodeURIComponent(mo[1]);
      const upload = mo[2];
      if (rawId === '') return text(405);
      if (!/^[-+]?\d+$/.test(rawId) || !inInt64(BigInt(rawId))) return json(400, { code: 400, message: "Input error: couldn't convert `" + rawId + '` to type `class java.lang.Long`' });
      const pid = key(normInt(BigInt(rawId)));
      if (upload && m === 'POST') {
        if (!this.pets.has(pid)) return json(404, { code: 404, message: 'Pet not found' });
        const ct = request.header('content-type') || '';
        let data = request.content;
        if (ct.startsWith('multipart/form-data')) {
          if (!ct.includes('boundary=') || !data.includes(Buffer.from('filename="'))) return json(400, { code: 400, message: 'file part missing' });
          const parts = data.toString('latin1').split('\r\n\r\n'); // Python: data.split(b"\r\n\r\n", 2)[-1]
          data = Buffer.from(parts.length >= 3 ? parts.slice(2).join('\r\n\r\n') : parts[parts.length - 1], 'latin1');
        } else if (ct.split(';')[0] !== 'application/octet-stream') {
          return text(415);
        }
        if (!data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return json(400, { code: 400, message: 'not an image' });
        this.uploads.push([ct.split(';')[0], data]);
        return json(200, { code: 200, type: 'unknown', message: 'ok' });
      }
      if (m === 'GET') {
        if (!this.authOk(request)) return json(401, { code: 401, message: 'unauthorized' });
        if (!this.pets.has(pid)) return text(404, 'Pet not found');
        return json(200, this.pets.get(pid));
      }
      if (m === 'POST') {
        if (!this.pets.has(pid)) return text(404, 'Pet not found');
        const fields = Object.fromEntries(request.url.searchParams.entries());
        if ((request.header('content-type') || '').startsWith('application/x-www-form-urlencoded')) Object.assign(fields, Object.fromEntries(parseQsl(request.content.toString('utf8'))));
        for (const k of ['name', 'status']) if (k in fields) this.pets.get(pid)[k] = fields[k];
        return json(200, this.pets.get(pid));
      }
      if (m === 'DELETE') {
        if (!this.authOk(request)) return json(401, { code: 401, message: 'unauthorized' });
        if (!this.pets.has(pid)) return text(404, 'Pet not found');
        this.pets.delete(pid);
        return text(200, 'Pet deleted');
      }
      return text(405);
    }
    return text(404);
  }

  readJson(request) {
    if ((request.header('content-type') || '').split(';')[0] !== 'application/json') return [null, text(415)];
    try {
      return [parseJson(request.content.length ? request.content : ''), null];
    } catch {
      return [null, json(400, { code: 400, message: 'bad json' })];
    }
  }

  storeUser(request, path, m) {
    if (path === '/store/inventory' && m === 'GET') {
      if (!this.authOk(request)) return text(401);
      return json(200, { available: this.pets.size });
    }
    if (path === '/store/order' && m === 'POST') {
      const [body, err] = this.readJson(request);
      if (err) return err;
      if (!isPlainObject(body) || !isInt(body.id)) return json(400, { code: 400, message: 'invalid order' });
      if (!(BigInt(body.id) > 0n && BigInt(body.id) < 1000n)) return json(400, { code: 400, message: 'order id must be < 1000' });
      this.orders.set(key(body.id), body);
      return json(200, body);
    }
    let mo = /^\/store\/order\/([^/]*)$/.exec(path);
    if (mo) {
      if (!/^[-+]?\d+$/.test(mo[1])) return json(400, { code: 400, message: 'bad id' });
      const oid = key(normInt(BigInt(mo[1])));
      if (m === 'GET') return this.orders.has(oid) ? json(200, this.orders.get(oid)) : text(404, 'Order not found');
      if (m === 'DELETE') {
        if (this.foreign_orders.has(oid)) throw new Error(`deleted someone else's order ${oid}`);
        return this.orders.delete(oid) ? text(200) : text(404);
      }
      return text(405);
    }
    if (path === '/user' && m === 'POST') {
      const [body, err] = this.readJson(request);
      if (err) return err;
      if (!isPlainObject(body) || typeof body.username !== 'string' || !body.username) return json(400, { code: 400, message: 'username required' });
      this.users.set(body.username, body);
      return json(200, body);
    }
    if (path === '/user/createWithList' && m === 'POST') {
      const [body, err] = this.readJson(request);
      if (err) return err;
      if (!Array.isArray(body) || !body.every((u) => isPlainObject(u) && typeof u.username === 'string')) return json(400, { code: 400, message: 'list of users expected' });
      for (const u of body) this.users.set(u.username, u);
      return json(200, body[0]); // v3 spec: returns a User
    }
    if ((path === '/user/login' || path === '/user/logout') && m === 'GET') return json(200, 'logged in user session');
    mo = /^\/user\/([^/]*)$/.exec(path);
    if (mo) {
      const name = decodeURIComponent(mo[1]);
      if ((m === 'PUT' || m === 'DELETE') && name === 'theUser') throw new Error("touched someone else's user theUser");
      if (m === 'GET') return this.users.has(name) ? json(200, this.users.get(name)) : text(404, 'User not found');
      if (m === 'PUT') {
        const [body, err] = this.readJson(request);
        if (err) return err;
        if (!this.users.has(name)) return text(404);
        if (!isPlainObject(body) || typeof body.username !== 'string') return json(400, { code: 400, message: 'invalid user' });
        this.users.set(name, body);
        return json(200, body);
      }
      if (m === 'DELETE') return this.users.delete(name) ? text(200) : text(404);
      return text(405);
    }
    return text(404);
  }

  authOk(request) {
    if (!this.require_auth) return true;
    const ok = request.header('api_key') === this.api_key;
    if (ok && this.expire_after_auth !== null) {
      this.auth_ok_count += 1;
      if (this.auth_ok_count > this.expire_after_auth) return false;
    }
    return ok;
  }

  upsert(request, create) {
    if ((request.header('content-type') || '').split(';')[0] !== 'application/json') return text(415);
    let body;
    try {
      body = parseJson(request.content.length ? request.content : '');
    } catch {
      return json(400, { code: 400, message: 'Input error: unable to parse JSON' });
    }
    if (!isPlainObject(body)) return json(400, { code: 400, message: 'body must be an object' });
    if (create && this.fail_create) return json(400, { code: 400, message: 'create disabled' });
    let pid = body.id;
    if (this.coerce_ids && (typeof pid === 'boolean' || (typeof pid === 'number' && !Number.isInteger(pid)))) {
      pid = typeof pid === 'boolean' ? Number(pid) : Math.trunc(pid);
      body.id = pid;
    }
    if (!this.strict && (!isInt(pid) || !inInt64(pid))) return json(400, { code: 400, message: 'cannot deserialize id' });
    if (this.strict) {
      if (!isInt(pid) || !inInt64(pid)) return json(400, { code: 400, message: 'invalid id' });
      if (typeof body.name !== 'string' || !body.name.trim()) return json(422, { code: 422, message: 'name required' });
      if (!Array.isArray(body.photoUrls)) return json(422, { code: 422, message: 'photoUrls required' });
      if ('status' in body && !['available', 'pending', 'sold'].includes(body.status)) return json(400, { code: 400, message: 'invalid status' });
      if ('category' in body && body.category !== null && !isPlainObject(body.category)) return json(400, { code: 400, message: 'invalid category' });
      if ('tags' in body && !Array.isArray(body.tags)) return json(400, { code: 400, message: 'invalid tags' });
    }
    if (!create && !this.pets.has(key(pid))) return text(404, 'Pet not found');
    this.pets.set(key(pid), body);
    this.ever_created.add(key(pid));
    return json(200, body);
  }
}

// ------------------------------------------------------------------------------------ export API
export const EXPORT_SPEC = {
  swagger: '2.0', info: { title: 'export demo', version: '1' }, host: 'exports.example.test',
  basePath: '/api', schemes: ['https'], consumes: ['application/json'], produces: ['application/json'],
  paths: {
    '/v1/report/export': { post: {
      tags: ['report-export-controller'], operationId: 'report-export',
      parameters: [{ in: 'body', name: 'body', required: true, schema: { $ref: '#/definitions/ExportReq' } }],
      responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/ModelAndView' } } } } },
    '/v1/broken/export': { post: {
      tags: ['broken-export-controller'], operationId: 'broken-export',
      parameters: [{ in: 'body', name: 'body', required: true, schema: { $ref: '#/definitions/ExportReq' } }],
      responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/ModelAndView' } } } } },
  },
  definitions: {
    ExportReq: { type: 'object', required: ['exportType'], properties: {
      exportType: { type: 'string', enum: ['XLSX', 'CSV', 'PDF'] },
      startDate: { type: 'string', format: 'date-time', example: '2023-01-01T00:00:00+03:00' },
      note: { type: 'string', example: 'monthly' } } },
    ModelAndView: { type: 'object', properties: { view: { type: 'string' } } },
  },
};

const FILES = {
  XLSX: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(40)]), 'report.xlsx'],
  CSV: ['text/csv', Buffer.from('tarih;değer\n2023-01-01;1\n', 'utf8'), 'report.csv'],
  PDF: ['application/pdf', Buffer.from('%PDF-1.4\n%apitest\n'), 'report.pdf'],
};

export async function exportTransport(req) {
  const request = new FakeRequest(req);
  let body;
  try {
    body = parseJson(request.content.length ? request.content : '');
  } catch {
    return json(400, { error: 'bad json' });
  }
  const kind = isPlainObject(body) ? body.exportType : null;
  if (typeof kind !== 'string' || !(kind in FILES)) return json(400, { error: 'exportType' });
  const [ct, data, name] = FILES[kind];
  if (request.url.pathname.endsWith('/broken/export') && kind === 'PDF') return json(200, { resultCode: 'E99', message: 'pdf service down' });
  return { status: 200, headers: { 'content-type': ct, 'content-disposition': `attachment; filename="${name}"` }, body: data };
}

/** Transport that records URLs and answers 200 {}. */
export function recordingTransport(calls) {
  return async (req) => {
    calls.push(req.url);
    return json(200, {});
  };
}
