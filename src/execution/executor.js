// Runs a Plan against a target.
//
// Per operation: baseline first. Baseline not 2xx+valid -> BASELINE_FAILED and the operation's other cases
// are SKIPPED (target option run_after_baseline_failure: they run anyway, each with an info finding). Auth matrix: operation needs the credential but none was given -> only AUTH-MISSING runs,
// everything else SKIPPED (no credential). Monitors: environment health (abort instead of reporting
// hundreds of defects) and credential expiry (stop auth-needing operations, allow resume with a new
// credential). Results are checkpointed to results.jsonl after every case; teardown always runs.
// Ctrl+C: the current request finishes, the remaining cases are recorded as not run, then teardown deletes
// everything this run created (a second Ctrl+C quits immediately).
import fs from 'node:fs';
import path from 'node:path';
import { detectAuth } from '../auth/detect.js';
import { redact, redactObj } from '../auth/masking.js';
import { FileValue, NO_BODY, OMIT, replaceRefs } from '../data/request.js';
import { curlBash, curlPowershell } from '../report/curl.js';
import { bulkCreateOps, extractAll, resourceOps } from '../resources/definitions.js';
import { ResourceManager, ResourceUnavailable } from '../resources/manager.js';
import {
  BASELINE_FAILED, CaseResult, CleanupProblem, ENVIRONMENT, ERROR, EnvironmentHealth, FAIL, Finding, KNOWN, PASS, RequestInfo,
  ResponseInfo, SKIPPED, WARN,
} from '../results.js';
import { dumps, parseJson } from '../util/json.js';
import { deepCopy } from '../util/py.js';
import { quote, urlencode } from '../util/url.js';
import { encodeBody, textOf } from './encoding.js';

const OK_BASELINE = new Set([PASS, WARN]);

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

export class RunOutcome {
  constructor(results, cleanup, health, aborted = false, abort_reason = null, requests_sent = 0) {
    Object.assign(this, { results, cleanup, health, aborted, abort_reason, requests_sent });
  }
}

/** What was actually sent (unmasked, internal only). */
class Sent {
  constructor(method, url, headers, body_text, body_obj = null) {
    Object.assign(this, { method, url, headers, body_text, body_obj, extra: {} });
  }
}

export class Executor {
  constructor({ api, plan, target, defaults, http, base_url, provider, oracle, resource_defs, builder, credential_env, run_dir = null, previous = null, progress = null }) {
    this.api = api;
    this.plan = plan;
    this.target = target;
    this.defaults = defaults;
    this.http = http;
    this.base_url = base_url.replace(/\/+$/, '');
    this.provider = provider;
    this.oracle = oracle;
    this.run_dir = run_dir;
    this.previous = previous || {};
    this.progress = progress || (() => {});
    this.secret_env = {};
    for (const s of provider.secrets()) this.secret_env[s] = credential_env;
    if (provider.expired_value && target.auth.expired_env) this.secret_env[provider.expired_value] = target.auth.expired_env;
    this.resources = new ResourceManager(api, resource_defs, builder, this, run_dir ? path.join(run_dir, 'created_resources.jsonl') : null);
    [this.create_ops, this.delete_ops] = resourceOps(resource_defs);
    this.bulk_ops = bulkCreateOps(resource_defs);
    this.resource_defs = resource_defs;
    this.health = new EnvironmentHealth();
    this._window = [];
    this._consecutiveErrors = 0;
    this._unauthStreak = [];
    this.credential_expired = false;
    this._credentialWorked = false;
    this.aborted = false;
    this.abort_reason = null;
    this.interrupted = false;
    this._acquired = [];
    this.immediate_cleanup = [];
  }

  // =========================================================================================== run
  async run() {
    const results = [];
    let cleanup = [];
    let presses = 0;
    const onSigint = () => {
      presses += 1;
      if (presses > 1) {
        process.stderr.write('\nsecond Ctrl+C: quitting without cleanup. Run `apitest cleanup --run <runId>` to delete leftovers.\n');
        process.exit(130);
      }
      process.stderr.write('\nCtrl+C: finishing the current request, then deleting everything this run created …\n');
      this.interrupted = true;
    };
    process.on('SIGINT', onSigint);
    try {
      for (const opPlan of this.plan.ops) {
        if (this.interrupted) break;
        results.push(...await this.runOperation(opPlan));
      }
      if (this.interrupted) {
        this.abort('interrupted by user (Ctrl+C)');
        const done = new Set(results.map((r) => r.case.id));
        for (const opPlan of this.plan.ops) {
          for (const c of opPlan.cases) if (!done.has(c.id)) results.push(this.skip(opPlan, c, 'run interrupted', false));
        }
      }
    } finally {
      try {
        const final = await this.resources.teardown();
        const deleted = new Set(this.resources.created.filter((r) => r.deleted).map((r) => r.kind + '|' + dumps(r.id)));
        // an early problem is stale if teardown later deleted (and verified) the resource
        const early = this.immediate_cleanup.filter((p) => !deleted.has(p.kind + '|' + dumps(p.resource_id)));
        cleanup = [...early, ...final];
      } catch (exc) { // teardown must never hide results
        cleanup = [new CleanupProblem('*', null, `teardown crashed: ${exc.message || exc}`)];
      }
      process.removeListener('SIGINT', onSigint);
    }
    return new RunOutcome(results, cleanup, this.health, this.aborted, this.abort_reason, this.http.requests_sent);
  }

  async runOperation(p) {
    const out = [];
    const cases = p.cases;
    if (!cases.length) return out;
    if (cases.every((c) => c.id in this.previous)) return cases.map((c) => this.previous[c.id]);
    if (this.aborted) return cases.map((c) => this.skip(p, c, `run aborted: ${this.abort_reason}`, false));
    if (p.skip_reason) return cases.map((c) => this.record(this.skip(p, c, p.skip_reason)));

    if (p.auth.needs && !this.provider.hasCredential()) {
      for (const c of cases) {
        if (c.rule_id === 'AUTH-MISSING') out.push(this.record(await this.execute(p, c)));
        else out.push(this.record(this.skip(p, c, `no credential given (operation needs ${this.target.auth.header})`, false)));
      }
      return out;
    }
    if (p.auth.needs && this.credential_expired) return cases.map((c) => this.skip(p, c, 'credential expired; resume with a new credential', false));

    const baseline = cases.find((c) => c.is_baseline) || null;
    let baseResult = null;
    let baselineNote = null;
    if (baseline !== null) {
      baseResult = this.previous[baseline.id] || null;
      if (baseResult === null) {
        baseResult = await this.execute(p, baseline);
        const status = baseResult.response ? baseResult.response.status : null;
        if (p.auth.needs && this._credentialWorked && this.target.auth.unauth_expect.includes(status)) {
          // the credential worked earlier in this run: this is expiry, not a broken operation
          this.markExpired();
          baseResult.status = SKIPPED;
          baseResult.final = false;
          baseResult.reason = `credential expired (baseline got ${status})`;
          out.push(this.record(baseResult));
          for (const c of cases) if (c !== baseline) out.push(this.skip(p, c, 'credential expired; resume with a new credential', false));
          return out;
        }
        if (baseResult.status === FAIL || baseResult.status === KNOWN) {
          baseResult.status = BASELINE_FAILED;
          baseResult.findings.push(new Finding('defect', `baseline failed: ${baseResult.reason}`, 'fail'));
        }
        this.record(baseResult);
        if (baseResult.status !== SKIPPED) this.healthBaseline(baseResult);
      }
      out.push(baseResult);
      if (baseResult.status === BASELINE_FAILED && this.target.run_after_baseline_failure) {
        baselineNote = new Finding('baseline', `baseline of this operation failed (${baseResult.reason}); this result may come from the same problem, not from the tested change`, 'info');
      } else if (!OK_BASELINE.has(baseResult.status)) {
        const transient = baseResult.status === ERROR;
        for (const c of cases) {
          if (c !== baseline) out.push(this.record(this.skip(p, c, `baseline ${baseResult.status}: ${baseResult.reason}`, !transient)));
        }
        return out;
      }
    }

    for (const c of cases) {
      if (c === baseline) continue;
      if (c.id in this.previous) {
        out.push(this.previous[c.id]);
        continue;
      }
      if (this.aborted) {
        out.push(this.skip(p, c, `run aborted: ${this.abort_reason}`, false));
        continue;
      }
      if (this.interrupted) {
        out.push(this.skip(p, c, 'run interrupted', false));
        continue;
      }
      if (p.auth.needs && this.credential_expired) {
        out.push(this.skip(p, c, 'credential expired; resume with a new credential', false));
        continue;
      }
      const r = await this.execute(p, c);
      if (baselineNote) r.findings.push(baselineNote);
      this.monitor(p, c, r);
      out.push(this.record(r));
    }
    return out;
  }

  // ===================================================================================== one case
  async execute(p, c) {
    const op = p.op;
    this.progress(c);
    const tpl = this.applyMutation(p.baseline, c);
    let authHeaders;
    if (c.group === 'auth') {
      const variant = this.provider.variant(c.rule_id);
      if (variant === null) {
        const why = c.rule_id === 'AUTH-EXPIRED' ? 'no expired credential supplied' : 'no credential given';
        return this.skip(p, c, why, false);
      }
      authHeaders = variant.headers || {};
    } else {
      authHeaders = p.auth.needs ? this.provider.headers() : {};
    }
    this._acquired = [];
    const m = c.mutation;
    const overrides = {};
    if (m.kind === 'raw_body') overrides.raw_body = m.value;
    else if (m.kind === 'content_type') overrides.content_type = m.value;
    else if (m.kind === 'method') {
      overrides.method = m.value.method;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(m.value.method)) overrides.purpose = 'consume'; // an undocumented write only ever hits a throw-away instance
    } else if (m.kind === 'path') overrides.raw_path = m.value;
    let resp;
    let sent;
    try {
      if (m.kind === 'tombstone') tpl.set(m.field, await this.resources.tombstoneId(m.value));
      await this.freshCreateId(op, c, tpl);
      [resp, sent] = await this.send(op, tpl, authHeaders, overrides);
    } catch (exc) {
      if (!(exc instanceof ResourceUnavailable)) throw exc;
      return new CaseResult({ case: c.summary(), operation: opInfo(op), status: ERROR, reason: exc.message, timestamp: nowIso(), findings: [new Finding(ENVIRONMENT, exc.message, 'fail')] });
    }
    await this.afterResponse(op, c, resp, sent);
    const verdict = this.oracle.evaluate(c, op, resp, sent.body_obj);
    return new CaseResult({
      case: c.summary(), operation: opInfo(op), status: verdict.status, reason: verdict.reason, findings: verdict.findings,
      request: this.maskedRequest(sent), response: this.maskedResponse(resp), curl_bash: sent.extra.curl_bash, curl_ps: sent.extra.curl_ps,
      known_issue: verdict.known_issue, timestamp: nowIso(),
    });
  }

  applyMutation(baseline, c) {
    const tpl = baseline.copy();
    const m = c.mutation;
    if (m.kind === 'set') tpl.set(m.field, deepCopy(m.value));
    else if (m.kind === 'replace') {
      const parts = deepCopy(m.value);
      tpl.path = parts.path;
      tpl.query = parts.query;
      tpl.headers = parts.headers;
      tpl.body = parts.body;
    }
    return tpl;
  }

  /** Sender interface (also used by the ResourceManager for setup/teardown requests). */
  async sendTemplate(op, tpl) {
    const authHeaders = detectAuth(op, this.target.auth).needs ? this.provider.headers() : {};
    const [resp, sent] = await this.send(op, tpl, authHeaders);
    return [resp, { body_obj: sent.body_obj, ...sent.extra }];
  }

  async send(op, tpl, authHeaders, { method = null, raw_path = null, raw_body = null, content_type = null, purpose = null } = {}) {
    const resolve = async (ref) => {
      const res = await this.resources.acquire(ref.kind, purpose || ref.purpose);
      this._acquired.push([ref.kind, res.id, purpose || ref.purpose]);
      return ref.field === 'id' ? res.id : res.data[ref.field] ?? null;
    };

    method = method || op.method;
    const headers = { Accept: 'application/json' };
    let bodyText = null;
    let content = null;
    let encoded = null;
    let body = NO_BODY;
    let url;
    if (raw_path !== null) { // unknown-path test: nothing but the path
      url = this.base_url + raw_path;
    } else {
      const pathVals = await replaceRefs(tpl.path, resolve);
      const query = await replaceRefs(tpl.query, resolve);
      const headersT = await replaceRefs(tpl.headers, resolve);
      if (['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(method) && method !== op.method) body = NO_BODY; // undocumented-method test: no body for body-less methods
      else body = tpl.body !== NO_BODY ? await replaceRefs(tpl.body, resolve) : NO_BODY;
      url = this.base_url + fillPath(op, pathVals);
      const pairs = queryPairs(op, query);
      if (pairs.length) url += '?' + urlencode(pairs);
      for (const [k, v] of Object.entries(headersT)) if (v !== OMIT) headers[k] = textOf(v);
      if (raw_body !== null) {
        bodyText = raw_body;
        content = Buffer.from(raw_body, 'utf8');
        headers['Content-Type'] = tpl.content_type || 'application/json';
      } else if (body !== NO_BODY) {
        encoded = encodeBody(tpl.encoding, body, tpl.content_type);
        bodyText = encoded.display;
        content = encoded.content;
        headers['Content-Type'] = encoded.content_type;
      }
      if (content_type !== null) headers['Content-Type'] = content_type;
    }
    Object.assign(headers, authHeaders);
    const resp = await this.http.send(method, url, headers, content);
    if (Object.keys(authHeaders).length && sameHeaders(authHeaders, this.provider.headers()) && resp.status !== null
        && resp.status < 500 && !this.target.auth.unauth_expect.includes(resp.status)) {
      this._credentialWorked = true;
    }
    this.log(method, url, resp);
    const sent = new Sent(method, url, headers, bodyText, body === NO_BODY || raw_body !== null ? null : body);
    const parts = encoded ? encoded.form_parts : null;
    const binary = encoded ? encoded.binary_file : null;
    const curlText = encoded ? encoded.data_text : bodyText;
    for (const f of [...(parts || []).filter(([, v]) => v instanceof FileValue).map(([, v]) => v), ...(binary ? [binary] : [])]) this.saveSample(f);
    sent.extra.curl_bash = redact(curlBash(method, url, headers, curlText, this.secret_env, parts, binary), Object.keys(this.secret_env));
    sent.extra.curl_ps = redact(curlPowershell(method, url, headers, curlText, this.secret_env, parts, binary), Object.keys(this.secret_env));
    return [resp, sent];
  }

  /** Files referenced by curl commands (-F file=@apitest.png) are saved in the run folder. */
  saveSample(f) {
    if (this.run_dir === null) return;
    const file = path.join(this.run_dir, f.filename);
    if (!fs.existsSync(file)) fs.writeFileSync(file, f.data);
  }

  /** Create operations whose ids come from a small shared range (probe configured): every request gets an
   *  id the server just reported as free, unless this case deliberately mutates the id. */
  async freshCreateId(op, c, tpl) {
    const kind = this.create_ops[op.operation_id];
    if (!kind) return;
    const d = this.resource_defs[kind];
    if (!d.probe_op || d.id_path.includes('.') || !tpl.body || typeof tpl.body !== 'object' || Array.isArray(tpl.body) || !(d.id_path in tpl.body)) return;
    const m = c.mutation;
    if (m.kind === 'set' && m.field !== null && m.field.location === 'body' && m.field.path[0] === d.id_path) return;
    tpl.body[d.id_path] = await this.resources.freeId(kind);
  }

  async afterResponse(op, c, resp, sent) {
    const ok = resp.status !== null && resp.status >= 200 && resp.status < 300;
    if (c.mutation.kind === 'method') {
      // an undocumented write may or may not have done something: never reuse that instance
      for (const [k, rid, purpose] of this._acquired) if (purpose === 'consume') this.keep(await this.resources.retire(k, rid));
      return;
    }
    if (!ok) return;
    const bulk = this.bulk_ops[op.operation_id];
    if (bulk && sent.body_obj !== null) {
      const [kind, p] = bulk;
      for (const res of this.resources.registerBulk(kind, extractAll(sent.body_obj, p))) this.keep(await this.resources.dispose(res));
    }
    let kind = this.create_ops[op.operation_id];
    if (kind) {
      // whatever a test case created is registered and deleted right away
      const [res, problem] = this.resources.registerFromResponse(kind, resp, { body_obj: sent.body_obj });
      this.keep(problem);
      if (res !== null) this.keep(await this.resources.dispose(res));
    }
    kind = this.delete_ops[op.operation_id];
    if (kind) {
      for (const [k, rid, purpose] of this._acquired) if (k === kind && purpose === 'consume') this.resources.markDeleted(k, rid);
    }
    if (!c.is_baseline) {
      // an accepted (possibly invalid) change may have corrupted the shared instance: replace it
      for (const [k, rid, purpose] of this._acquired) if (purpose === 'mutate') this.keep(await this.resources.retire(k, rid));
    }
  }

  keep(problem) {
    if (problem) this.immediate_cleanup.push(problem);
  }

  // ===================================================================================== monitors
  healthBaseline(r) {
    this.health.baselines_run += 1;
    const status = r.response ? r.response.status : null;
    const unhealthy = r.status === ERROR || (status !== null && status >= 500);
    if (OK_BASELINE.has(r.status)) this.health.baselines_ok += 1;
    const win = this.defaults.health_baseline_window;
    if (this._window.length < win) {
      this._window.push(unhealthy);
      if (this._window.length === win) {
        const bad = this._window.filter(Boolean).length;
        if (bad / this._window.length >= this.defaults.health_baseline_fail_ratio) {
          this.abort(`target environment unhealthy: ${bad}/${this._window.length} baselines failed with 5xx/timeouts/network errors`);
        }
      }
    }
  }

  monitor(p, c, r) {
    const status = r.response ? r.response.status : null;
    if (r.status === ERROR && r.response && r.response.error) {
      if ((r.reason || '').includes('timeout')) this.health.timeouts += 1;
      else this.health.network_errors += 1;
    }
    if (status !== null && status >= 500) this.health.server_errors += 1;
    if (r.status === ERROR || (status !== null && status >= 500)) {
      this._consecutiveErrors += 1;
      if (this._consecutiveErrors >= this.defaults.health_max_consecutive_errors) {
        this.abort(`target environment unhealthy: ${this._consecutiveErrors} consecutive 5xx/timeouts/network errors`);
      }
    } else {
      this._consecutiveErrors = 0;
    }
    // credential expiry: valid-auth requests of operations whose baseline passed start failing
    if (p.auth.needs && c.group !== 'auth') {
      if (this.target.auth.unauth_expect.includes(status)) {
        this._unauthStreak.push(r);
        if (this._unauthStreak.length >= this.defaults.credential_expiry_consecutive) {
          this.markExpired();
          for (const prev of this._unauthStreak) {
            prev.status = SKIPPED;
            prev.final = false;
            prev.reason = `credential expired (got ${prev.response ? prev.response.status : '?'})`;
            this.record(prev);
          }
        }
      } else {
        this._unauthStreak = [];
      }
    }
  }

  markExpired() {
    if (!this.credential_expired) {
      this.credential_expired = true;
      this.health.credential_expired = true;
      this.health.notes.push('credential looks expired: it worked earlier in this run, then auth failures started; operations needing it were stopped. Resume with a new credential.');
    }
  }

  abort(reason) {
    if (!this.aborted) {
      this.aborted = true;
      this.abort_reason = reason;
      this.health.aborted = true;
      this.health.abort_reason = reason;
    }
  }

  // ===================================================================================== helpers
  skip(p, c, reason, final = true) {
    return new CaseResult({ case: c.summary(), operation: opInfo(p.op), status: SKIPPED, reason, final, timestamp: nowIso() });
  }

  maskedRequest(sent) {
    const secrets = Object.keys(this.secret_env);
    return new RequestInfo(sent.method, redact(sent.url, secrets), redactObj(sent.headers, secrets), sent.body_text !== null ? redact(sent.body_text, secrets) : null);
  }

  maskedResponse(resp) {
    const secrets = Object.keys(this.secret_env);
    return new ResponseInfo(resp.status, redactObj(resp.headers, secrets), redact(resp.text(), secrets), resp.content_type, resp.elapsed_ms, resp.error);
  }

  record(r) {
    if (this.run_dir !== null) fs.appendFileSync(path.join(this.run_dir, 'results.jsonl'), dumps(r.toDict()) + '\n', 'utf8');
    return r;
  }

  log(method, url, resp) {
    if (this.run_dir === null) return;
    const line = `${nowIso()} ${method} ${redact(url, Object.keys(this.secret_env))} -> `
      + (resp.status !== null ? `${resp.status} ${Math.round(resp.elapsed_ms)}ms` : `ERROR ${resp.error}`);
    fs.appendFileSync(path.join(this.run_dir, 'run.log'), line + '\n', 'utf8');
  }
}

function sameHeaders(a, b) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

function opInfo(op) {
  return { operation_id: op.operation_id, method: op.method, path: op.path, tags: op.tags, summary: op.summary };
}

function fillPath(op, values) {
  let p = op.path;
  for (const param of op.params('path')) {
    const v = Object.prototype.hasOwnProperty.call(values, param.name) ? values[param.name] : OMIT;
    p = p.split('{' + param.name + '}').join(v === OMIT || v === null ? '' : quote(textOf(v)));
  }
  return p;
}

function queryPairs(op, query) {
  const styles = Object.fromEntries(op.params('query').map((p) => [p.name, p]));
  const pairs = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === OMIT) continue;
    if (Array.isArray(v)) {
      const p = styles[k];
      let explode = p ? p.explode : true;
      if (p && p.collection_format) explode = p.collection_format === 'multi';
      if (explode) for (const x of v) pairs.push([k, textOf(x)]);
      else {
        const sep = { ssv: ' ', tsv: '\t', pipes: '|' }[p ? p.collection_format : ''] ?? ',';
        pairs.push([k, v.map(textOf).join(sep)]);
      }
    } else {
      pairs.push([k, textOf(v)]);
    }
  }
  return pairs;
}

/** Final results from an earlier attempt of this run (last record per case wins). */
export function loadPrevious(runDir) {
  const file = path.join(runDir, 'results.jsonl');
  const latest = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const r = CaseResult.fromDict(parseJson(line));
      latest[r.case.id] = r;
    }
  }
  return Object.fromEntries(Object.entries(latest).filter(([, v]) => v.final));
}
