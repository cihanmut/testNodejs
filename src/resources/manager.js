// Resource lifecycle: create what tests need, hand out instances by purpose, delete everything at the end
// (even when tests fail), and report what could not be cleaned up.
//
// Pools per resource kind:
//   read    - one instance for GET-style cases (never modified)
//   mutate  - one instance for PUT/POST-on-item cases (each request sends a full body)
//   consume - instances for DELETE cases; replaced only after one was actually deleted
// Every created ID is appended to created_resources.jsonl immediately, so `apitest cleanup` can finish
// the job after a crash.
import fs from 'node:fs';
import { renderTemplate } from '../data/values.js';
import { CleanupProblem } from '../results.js';
import { dumps, isPlainObject, parseJson } from '../util/json.js';
import { pyRepr, sleep as realSleep } from '../util/py.js';

export class ResourceUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResourceUnavailable';
  }
}

export class Resource {
  constructor(kind, id, data = {}, deleted = false) {
    Object.assign(this, { kind, id, data, deleted });
  }
}

export function extractPath(data, dotted) {
  let node = data;
  for (const part of dotted.split('.').filter(Boolean)) {
    if (isPlainObject(node) && Object.prototype.hasOwnProperty.call(node, part)) node = node[part];
    else if (Array.isArray(node) && /^\d+$/.test(part) && Number(part) < node.length) node = node[Number(part)];
    else return null;
  }
  return node === undefined ? null : node;
}

export function fillId(value, rid) {
  if (Array.isArray(value)) return value.map((v) => fillId(v, rid));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillId(v, rid)]));
  if (value === '{id}') return rid;
  if (typeof value === 'string' && value.includes('{id}')) return value.split('{id}').join(String(rid));
  return value;
}

/** Same resource id? (ids may be numbers, BigInts or strings) */
const sameId = (a, b) => a === b || (typeof a !== 'object' && typeof b !== 'object' && typeof a !== 'string' && typeof b !== 'string' && a == b); // eslint-disable-line eqeqeq
const ok2xx = (resp) => !resp.error && resp.status !== null && resp.status >= 200 && resp.status < 300;

export class ResourceManager {
  static VERIFY_ATTEMPTS = 4; // some servers show a delete only after a few seconds (Petstore v2)
  static VERIFY_BACKOFF_S = 1.0; // waits 1s, 2s, 4s between checks

  /** sender: { sendTemplate(op, tpl) -> Promise<[ResponseRecord, sentInfo]> } */
  constructor(api, defs, builder, sender, registryPath = null, sleepFn = realSleep) {
    this._sleep = sleepFn;
    this.api = api;
    this.defs = defs;
    this.builder = builder;
    this.sender = sender;
    this.registry_path = registryPath;
    this.created = [];
    this._pools = { read: new Map(), mutate: new Map(), consume: new Map() };
    this._failures = new Map();
    this._honorsClientId = new Map(); // kind -> server stores data under the id we send
    this._tombstones = new Map();
  }

  // -- acquiring --------------------------------------------------------------------------------
  async acquire(kind, purpose = 'read') {
    if (!(kind in this.defs)) throw new ResourceUnavailable(`no resource definition for '${kind}'`);
    if (this._failures.has(kind)) throw new ResourceUnavailable(this._failures.get(kind));
    const pool = this._pools[purpose] || this._pools.read;
    let res = pool.get(kind);
    if (!res || res.deleted) {
      res = await this.create(kind);
      pool.set(kind, res);
    }
    return res;
  }

  async create(kind) {
    const d = this.defs[kind];
    const op = this.api.operation(d.create_op);
    const tpl = this.builder.build(op);
    if (d.probe_op && isPlainObject(tpl.body) && !d.id_path.includes('.')) tpl.body[d.id_path] = await this.freeId(kind);
    const [resp, sent] = await this.sender.sendTemplate(op, tpl);
    if (!ok2xx(resp)) {
      const msg = `setup failed: could not create ${kind} via ${op.operation_id}: ` + (resp.error || `HTTP ${resp.status} ${resp.text(300)}`);
      const transient = resp.error !== null || (resp.status || 0) >= 500;
      if (!transient) this._failures.set(kind, msg); // deterministic failure (4xx): don't hammer the server
      throw new ResourceUnavailable(msg);
    }
    const rid = this.extractId(d, resp, sent);
    if (rid === null) throw new ResourceUnavailable(`setup failed: no id at '${d.id_path}' in ${kind} create ${d.id_from}`);
    const sentId = sent && typeof sent === 'object' ? extractPath(sent.body_obj, d.id_path) : null;
    if (sentId !== null) this._honorsClientId.set(kind, sameId(sentId, rid));
    return this.registerCreated(kind, rid);
  }

  /** An id from the resource's body template that the server reports as unused (probe -> 404). Needed
   *  where ids come from a small range shared with other users (Petstore orders < 1000). */
  async freeId(kind) {
    const d = this.defs[kind];
    const template = (d.body || {})[d.id_path];
    let lastStatus = null;
    for (let i = 0; i < Math.max(1, d.probe_attempts); i++) {
      const candidate = renderTemplate(template, this.builder.ctx);
      if (!d.probe_op) return candidate;
      const op = this.api.operation(d.probe_op);
      const [resp] = await this.sender.sendTemplate(op, this.templateFor(op, d.probe_params, candidate));
      lastStatus = resp.status;
      if (resp.status === d.probe_expect) return candidate;
    }
    throw new ResourceUnavailable(`setup failed: no free ${kind} id found in ${d.probe_attempts} attempts (probe ${d.probe_op} last returned ${lastStatus})`);
  }

  registerBulk(kind, ids) {
    return ids.map((rid) => this.registerCreated(kind, rid, 'test'));
  }

  extractId(d, resp, sent) {
    if (d.id_from === 'request') {
      const body = sent && typeof sent === 'object' ? sent.body_obj : null;
      return extractPath(body, d.id_path);
    }
    try {
      return extractPath(parseJson(resp.body), d.id_path);
    } catch {
      return null;
    }
  }

  registerCreated(kind, rid, source = 'setup') {
    for (const r of this.created) {
      if (r.kind === kind && sameId(r.id, rid)) {
        if (r.deleted) { // same id created again (e.g. a create test re-used it)
          r.deleted = false;
          this.log('created', kind, rid, source);
        }
        return r;
      }
    }
    const res = new Resource(kind, rid);
    this.created.push(res);
    this.log('created', kind, rid, source);
    return res;
  }

  /** A create operation returned 2xx inside a test case: whatever it created must be cleaned up. If we
   *  sent an ID and the server stored the data under a DIFFERENT one (e.g. 1.5 coerced to 1), that ID may
   *  belong to someone else: never delete it automatically, report it instead. */
  registerFromResponse(kind, resp, sent) {
    const d = this.defs[kind];
    const rid = this.extractId(d, resp, sent);
    if (rid === null) return [null, null];
    const sentId = sent && typeof sent === 'object' ? extractPath(sent.body_obj, d.id_path) : null;
    if (d.id_from === 'response' && sentId !== null && !sameId(sentId, rid) && (this._honorsClientId.get(kind) ?? true)) {
      this.log('foreign', kind, rid, `server stored data under id ${pyRepr(rid)}, request sent ${pyRepr(sentId)}`);
      return [null, new CleanupProblem(kind, rid, `server stored test data under id ${pyRepr(rid)} although the request sent ${pyRepr(sentId)}; `
        + 'not deleted automatically because that id may belong to someone else - check it manually')];
    }
    return [this.registerCreated(kind, rid, 'test'), null];
  }

  markDeleted(kind, rid) {
    for (const r of this.created) {
      if (r.kind === kind && sameId(r.id, rid) && !r.deleted) {
        r.deleted = true;
        this.log('deleted', kind, rid, 'test');
      }
    }
  }

  /** Delete a resource right away (e.g. created by a test case, or corrupted by an accepted invalid
   *  update) so it cannot pollute later cases or the shared server. */
  async dispose(res) {
    for (const pool of Object.values(this._pools)) if (pool.get(res.kind) === res) pool.delete(res.kind);
    if (res.deleted) return null;
    return this.delete(res);
  }

  async retire(kind, rid) {
    const res = this.created.find((r) => r.kind === kind && sameId(r.id, rid));
    return res ? this.dispose(res) : null;
  }

  owns(kind, rid) {
    return this.created.some((r) => r.kind === kind && sameId(r.id, rid));
  }

  // -- not-found IDs ----------------------------------------------------------------------------
  /** An ID guaranteed not to exist: create, delete, verify 404 (cached per run). */
  async tombstoneId(kind) {
    if (this._tombstones.has(kind)) return this._tombstones.get(kind);
    const res = await this.create(kind);
    const problem = await this.delete(res);
    if (problem) throw new ResourceUnavailable(`tombstone for ${kind} failed: ${problem.message}`);
    this._tombstones.set(kind, res.id);
    return res.id;
  }

  // -- teardown ---------------------------------------------------------------------------------
  async teardown() {
    const problems = [];
    for (const res of [...this.created].reverse()) {
      if (res.deleted) continue;
      const p = await this.delete(res);
      if (p) problems.push(p);
    }
    return problems;
  }

  async delete(res) {
    const d = this.defs[res.kind];
    if (!d.delete_op) return new CleanupProblem(res.kind, res.id, 'no delete operation configured; remove manually');
    const op = this.api.operation(d.delete_op);
    const tpl = this.templateFor(op, d.delete_params, res.id);
    const [resp, sent] = await this.sender.sendTemplate(op, tpl);
    const curl = (k) => (sent && typeof sent === 'object' ? sent[k] ?? null : null);
    if (!ok2xx(resp)) {
      if (resp.status === 404 && await this.verifyGone(res)) {
        res.deleted = true;
        this.log('deleted', res.kind, res.id, 'teardown (already gone)');
        return null;
      }
      return new CleanupProblem(res.kind, res.id, `delete via ${op.operation_id} failed: ${resp.error || `HTTP ${resp.status}`}`, curl('curl_bash'), curl('curl_ps'));
    }
    if (!await this.verifyGone(res)) return new CleanupProblem(res.kind, res.id, `deleted via ${op.operation_id} but still retrievable`, curl('curl_bash'), curl('curl_ps'));
    res.deleted = true;
    this.log('deleted', res.kind, res.id, 'teardown');
    return null;
  }

  /** GET must return the 'gone' status. Retried with backoff: eventually-consistent servers keep returning
   *  a deleted resource for a few seconds. */
  async verifyGone(res) {
    const d = this.defs[res.kind];
    if (!d.verify_op) return true;
    const op = this.api.operation(d.verify_op);
    const tpl = this.templateFor(op, d.verify_params, res.id);
    const attempts = ResourceManager.VERIFY_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const [resp] = await this.sender.sendTemplate(op, tpl);
      if (resp.status === d.verify_expect) return true;
      if (resp.status !== null && resp.status >= 500) return false; // the server can't tell us; report it rather than hammering
      if (attempt < attempts - 1) await this._sleep(ResourceManager.VERIFY_BACKOFF_S * 2 ** attempt);
    }
    return false;
  }

  templateFor(op, params, rid) {
    const tpl = this.builder.build(op);
    for (const [name, value] of Object.entries(fillId(params, rid))) {
      const p = op.parameters.find((x) => x.name === name);
      tpl.section(p ? p.location : 'query')[name] = value;
    }
    return tpl;
  }

  log(event, kind, rid, source) {
    if (!this.registry_path) return;
    const rec = { event, kind, id: rid, source, time: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00') };
    fs.appendFileSync(this.registry_path, dumps(rec) + '\n', 'utf8');
  }
}

/** [kind, id] pairs created but not deleted, from a created_resources.jsonl file. */
export function pendingFromRegistry(file) {
  if (!fs.existsSync(file)) return [];
  const state = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const rec = parseJson(line);
    if (!['created', 'deleted'].includes(rec.event)) continue; // e.g. "foreign": ids we must never delete automatically
    const key = rec.kind + '|' + dumps(rec.id);
    state.set(key, [rec.kind, rec.id, rec.event === 'deleted']);
  }
  return [...state.values()].filter(([, , deleted]) => !deleted).map(([k, i]) => [k, i]);
}
