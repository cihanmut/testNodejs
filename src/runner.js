// Orchestration used by the CLI: load target + spec, build the plan, execute, write the run folder.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mask } from './auth/masking.js';
import { buildProvider } from './auth/provider.js';
import { credentialEnvName, resolveCredential } from './config/loader.js';
import { DeniedHostError } from './config/safety.js';
import { BaselineBuilder } from './data/baseline.js';
import { ValueContext } from './data/values.js';
import { Executor, loadPrevious, nowIso } from './execution/executor.js';
import { RateLimiter, SafeHttpClient } from './execution/http.js';
import { Filters, Plan, buildPlan } from './generators/plan.js';
import { Oracle, loadKnownIssues } from './oracle/oracle.js';
import { csvLine, writeAll } from './report/exports.js';
import { buildReportData } from './report/model.js';
import { inferBindings, loadResourceDefs, validateDefs } from './resources/definitions.js';
import { Resource, pendingFromRegistry } from './resources/manager.js';
import { runMeta } from './results.js';
import { specFindings } from './spec/analyze.js';
import { diffSpecs } from './spec/diff.js';
import { loadSpecSource } from './spec/loader.js';
import { normalize } from './spec/normalize.js';
import { dumps, parseJson } from './util/json.js';
import { loadYamlFile } from './util/yaml.js';

export const EXIT_OK = 0;
export const EXIT_FAILURES = 1;
export const EXIT_ABORTED = 2;
export const EXIT_USAGE = 3;
export const EXIT_DENIED = 4;

export class RunError extends Error {
  constructor(message, code = EXIT_USAGE) {
    super(message);
    this.name = 'RunError';
    this.code = code;
  }
}

/** Test hook: tests set this to an in-memory transport (like httpx.MockTransport in the Python tests). */
export const testHooks = { transport: null };

export function makeHttp(cfg, profile = null, { allowOnceUrl = null, transport = null } = {}) {
  const d = cfg.defaults;
  return new SafeHttpClient(cfg.denylist, {
    timeout_connect: d.timeout_connect, timeout_read: d.timeout_read, retries: d.network_retries, backoff_s: d.retry_backoff_s,
    rate_limiter: new RateLimiter(profile ? profile.rate_limit_rps : null), proxy: d.proxy, ca_bundle: d.ca_bundle,
    transport: transport || testHooks.transport, allow_once_url: allowOnceUrl,
  });
}

export async function loadTargetApi(cfg, target, http, specOverride = null) {
  const loaded = await loadSpecSource(specOverride || target.spec, http);
  return [normalize(loaded, target.exports.tag_pattern), loaded];
}

export function baseUrlFor(target, api) {
  if (target.base_url) return target.base_url.replace(/\/+$/, '');
  const absolute = api.servers.filter((s) => s.includes('://'));
  if (!absolute.length) throw new RunError(`target '${target.name}': spec has no absolute server URL; set base_url in config`);
  return absolute[0];
}

export function newRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

export function planFor(cfg, target, api, { level, runId, filters, includeExports, allowInjection = false }) {
  const profile = cfg.profileFor(target);
  const resources = loadResourceDefs(target.resources);
  const problems = validateDefs(resources, api);
  if (problems.length) throw new RunError('resource config problems:\n  ' + problems.join('\n  '));
  const ctx = new ValueContext(runId, cfg.defaults.seed, target.timezone_offset);
  const plan = buildPlan(api, target, profile, {
    level, runId, seed: cfg.defaults.seed, filters, includeExports, overrides: loadYamlFile(target.overrides) || {}, resources, valueCtx: ctx,
    allowInjection: allowInjection && profile.allow_injection,
  });
  return [plan, ctx, resources];
}

export function writeCasesCsv(plan, file) {
  let text = csvLine(['case_id', 'operation_id', 'method', 'path', 'technique', 'rule_id', 'field', 'value', 'expect', 'expect_codes', 'level', 'needs_auth', 'title', 'note']);
  for (const p of plan.ops) {
    for (const c of p.cases) {
      const s = c.summary();
      text += csvLine([c.id, p.op.operation_id, p.op.method, p.op.path, c.technique, c.rule_id, c.field || '', s.value ?? '', c.expectation.kind,
        c.expectation.codes.join(' '), c.level, c.needs_auth, c.title, p.skip_reason || '']);
    }
  }
  fs.writeFileSync(file, text, 'utf8');
}

// ============================================================================================== run
export async function executeRun(cfg, targetName, {
  level = null, filters = null, includeExports = null, credential = null, credentialEnv = null, resume = null, runsDir = null, transport = null,
  echo = console.log, progress = null, allowInjection = false,
} = {}) {
  runsDir = runsDir || path.join(cfg.project_root, 'runs');
  let previous = {};
  let runDir;
  let runId;
  let specSource = null;
  let started;
  let prevRequests = 0;
  if (resume) {
    runDir = findRunDir(runsDir, resume);
    const state = parseJson(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    const m = state.meta;
    targetName = m.target;
    runId = m.run_id;
    level = m.level;
    includeExports = m.include_exports;
    allowInjection = Boolean(m.allow_injection);
    filters = new Filters(m.filters);
    specSource = snapshotOf(runDir);
    previous = loadPrevious(runDir);
    started = m.started;
    prevRequests = Number(m.requests_sent || 0);
  } else {
    if (!targetName) throw new RunError('--target is required (or --resume <runId>)');
    runId = newRunId();
    started = nowIso();
  }
  const target = cfg.target(targetName);
  const profile = cfg.profileFor(target);
  level = level || cfg.defaults.level;
  filters = filters || new Filters();
  includeExports = includeExports === null || includeExports === undefined ? cfg.defaults.include_exports : includeExports;

  // Hard safety gate BEFORE any network activity for a denylisted target.
  if (cfg.denylist.isDenied(target.spec) || (target.base_url && cfg.denylist.isDenied(target.base_url))) {
    throw new RunError(`target '${target.name}' is on the host denylist: only analyze and generate --dry-run are allowed`, EXIT_DENIED);
  }

  const http = makeHttp(cfg, profile, { transport });
  let meta;
  let api;
  let plan;
  let outcome;
  let executor;
  try {
    let loaded;
    [api, loaded] = await loadTargetApi(cfg, target, http, specSource);
    const baseUrl = baseUrlFor(target, api);
    if (cfg.denylist.isDenied(baseUrl)) {
      throw new RunError(`target '${target.name}' base URL ${baseUrl} is on the host denylist: only analyze and generate --dry-run are allowed`, EXIT_DENIED);
    }
    allowInjection = allowInjection && profile.allow_injection; // never on public-demo
    let ctx;
    let resourceDefs;
    [plan, ctx, resourceDefs] = planFor(cfg, target, api, { level, runId, filters, includeExports, allowInjection });
    if (!plan.ops.length) throw new RunError('no operations match the filters');

    runDir = path.join(runsDir, target.name, runId);
    fs.mkdirSync(runDir, { recursive: true });
    if (!resume) {
      const ext = loaded.text.trimStart().startsWith('{') ? '.json' : '.yaml';
      fs.writeFileSync(path.join(runDir, `spec_snapshot${ext}`), loaded.text, 'utf8');
    }

    const [cred, credSource] = resolveCredential(cfg, target, credential, credentialEnv);
    const expired = target.auth.expired_env ? process.env[target.auth.expired_env] || null : null;
    const provider = buildProvider(target.auth.header, cred, target.auth.prefix, expired);
    const envName = credentialEnvName(target, credentialEnv);
    const credText = cred ? `given (${mask(cred)}) via ${credSource}` : (target.auth.header ? 'not given' : 'target has no auth');

    meta = runMeta({
      run_id: runId, target: target.name, spec_title: api.title, spec_version: api.spec_version, spec_sha256: api.sha256, spec_source: target.spec,
      base_url: baseUrl, level, profile: profile.name, seed: cfg.defaults.seed, filters: filters.toDict(), include_exports: includeExports,
      credential: credText, credential_env: envName, started, allow_injection: allowInjection,
    });
    writeRunJson(runDir, meta, null, [], api, 0, plan.findings);

    echo(`run ${runId}: ${plan.cases.length} cases on ${plan.ops.length} operations, level ${level}, profile ${profile.name} (${profile.rate_limit_rps} req/s), credential ${credText}`);
    const builder = new BaselineBuilder(target, ctx, loadYamlFile(target.overrides) || {}, inferBindings(api, resourceDefs), resourceDefs);
    const oracle = new Oracle(loadKnownIssues(target.known_issues), cfg.defaults.response_time_warn_ms, target.auth.login_redirect_pattern, target.envelope, target.exports);
    executor = new Executor({
      api, plan, target, defaults: cfg.defaults, http, base_url: baseUrl, provider, oracle, resource_defs: resourceDefs, builder,
      credential_env: envName, run_dir: runDir, previous, progress,
    });
    if (resume) executor.resources.created = pendingFromRegistry(path.join(runDir, 'created_resources.jsonl')).map(([k, rid]) => new Resource(k, rid));
    outcome = await executor.run();
  } catch (exc) {
    if (exc instanceof DeniedHostError) throw new RunError(exc.message, EXIT_DENIED);
    throw exc;
  } finally {
    http.close();
  }

  meta.finished = nowIso();
  meta.state = outcome.aborted ? 'aborted' : 'finished';
  meta.requests_sent = outcome.requests_sent + prevRequests;
  writeRunJson(runDir, meta, outcome.health, outcome.cleanup, api, executor.resources.created.length, plan.findings);
  const outputs = writeAll(runDir, cfg.defaults.report_formats && cfg.defaults.report_formats.length ? cfg.defaults.report_formats : ['html']);
  const report = outputs.find((o) => o.endsWith('.html')) || path.join(runDir, 'report.html');
  const data = buildReportData(runDir);
  echo(consoleSummary(data, report, outputs.filter((o) => !o.endsWith('.html'))));
  if (outcome.aborted || outcome.health.credential_expired) return [runDir, EXIT_ABORTED];
  return [runDir, data.failing || outcome.cleanup.length ? EXIT_FAILURES : EXIT_OK];
}

function writeRunJson(runDir, meta, health, cleanup, api, created, planFindings = null) {
  const data = {
    meta,
    health: health ? { ...health, notes: [...health.notes] } : {},
    cleanup: cleanup.map((c) => ({ kind: c.kind, resource_id: c.resource_id, message: c.message, curl_bash: c.curl_bash, curl_ps: c.curl_ps })),
    created_resources: created,
    spec_findings: [...specFindings(api).map((f) => ({ kind: f.kind, message: f.message, operations: f.operations })), ...mergeFindings(planFindings || [])],
  };
  fs.writeFileSync(path.join(runDir, 'run.json'), dumps(data, { indent: 2 }), 'utf8');
}

function snapshotOf(runDir) {
  const snap = fs.readdirSync(runDir).find((f) => f.startsWith('spec_snapshot.'));
  return snap ? path.join(runDir, snap) : null;
}

/** A spec reference is a file, a URL / editor link, or a run id (its saved spec snapshot). */
export function resolveSpecRef(cfg, ref, runsDir = null) {
  if (ref.includes('://') || (fs.existsSync(ref) && fs.statSync(ref).isFile())) return ref;
  let runDir;
  try {
    runDir = findRunDir(runsDir || path.join(cfg.project_root, 'runs'), ref);
  } catch (exc) {
    if (exc instanceof RunError) throw new RunError(`'${ref}' is not a spec file, URL or run id`);
    throw exc;
  }
  const snap = snapshotOf(runDir);
  if (!snap) throw new RunError(`run '${ref}' has no spec snapshot`);
  return snap;
}

export async function specDiff(cfg, oldRef, newRef, { exportPattern = null, transport = null } = {}) {
  const http = makeHttp(cfg, null, { transport });
  try {
    const oldApi = normalize(await loadSpecSource(resolveSpecRef(cfg, oldRef), http), exportPattern);
    const newApi = normalize(await loadSpecSource(resolveSpecRef(cfg, newRef), http), exportPattern);
    return diffSpecs(oldApi, newApi);
  } finally {
    http.close();
  }
}

/** Diff of an older spec (file / URL / run id) against the target's current spec. */
export function changedSince(cfg, target, oldRef, transport = null) {
  return specDiff(cfg, oldRef, target.spec, { exportPattern: target.exports.tag_pattern, transport });
}

/** One entry per (kind, message) with all operations merged. */
export function mergeFindings(findings) {
  const merged = new Map();
  for (const f of findings) {
    const key = f.kind + '\u0000' + f.message;
    if (!merged.has(key)) merged.set(key, { kind: f.kind, message: f.message, operations: [] });
    const entry = merged.get(key);
    for (const op of f.operations || []) if (!entry.operations.includes(op)) entry.operations.push(op);
  }
  return [...merged.values()];
}

export function findRunDir(runsDir, run) {
  if (fs.existsSync(path.join(run, 'run.json'))) return run;
  if (fs.existsSync(runsDir)) {
    for (const t of fs.readdirSync(runsDir)) {
      const candidate = path.join(runsDir, t, run);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    }
  }
  throw new RunError(`run '${run}' not found under ${runsDir}`);
}

export function consoleSummary(data, report, extra = null) {
  const c = data.counts;
  const parts = data.statuses.filter((s) => c[s]).map((s) => `${s} ${c[s]}`);
  const lines = [`results: ${parts.join(', ') || 'none'}  (total ${data.total})`];
  const h = data.health;
  if (h.aborted) lines.push(`ABORTED: ${h.abort_reason}`);
  if (h.credential_expired) lines.push('CREDENTIAL EXPIRED: resume with a new credential (apitest run --resume <runId>)');
  if (data.cleanup.length) lines.push(`CLEANUP PROBLEMS: ${data.cleanup.length} resource(s) not deleted — see report section 4`);
  lines.push(`report: ${report}`);
  if (extra && extra.length) lines.push('also: ' + extra.map((p) => path.basename(p)).join(', '));
  return lines.join('\n');
}

export function renderReport(cfg, run, runsDir = null, formats = null) {
  const runDir = findRunDir(runsDir || path.join(cfg.project_root, 'runs'), run);
  return writeAll(runDir, formats || (cfg.defaults.report_formats && cfg.defaults.report_formats.length ? cfg.defaults.report_formats : ['html']));
}

/** Retry deleting resources a run left behind (from created_resources.jsonl). */
export async function cleanupRun(cfg, run, { credential = null, credentialEnv = null, runsDir = null, transport = null, echo = console.log } = {}) {
  const runDir = findRunDir(runsDir || path.join(cfg.project_root, 'runs'), run);
  const m = parseJson(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')).meta;
  const pending = pendingFromRegistry(path.join(runDir, 'created_resources.jsonl'));
  if (!pending.length) {
    echo('nothing to clean up: every created resource is recorded as deleted');
    return EXIT_OK;
  }
  const target = cfg.target(m.target);
  if (cfg.denylist.isDenied(m.base_url)) throw new RunError('denylisted host', EXIT_DENIED);
  const http = makeHttp(cfg, cfg.profileFor(target), { transport });
  let problems;
  try {
    const [api] = await loadTargetApi(cfg, target, null, snapshotOf(runDir));
    const defs = loadResourceDefs(target.resources);
    const ctx = new ValueContext(m.run_id, cfg.defaults.seed, target.timezone_offset);
    const builder = new BaselineBuilder(target, ctx, {}, inferBindings(api, defs), defs);
    const [cred] = resolveCredential(cfg, target, credential, credentialEnv);
    const provider = buildProvider(target.auth.header, cred, target.auth.prefix);
    const plan = new Plan({ target, level: 'smoke', ops: [] });
    const executor = new Executor({
      api, plan, target, defaults: cfg.defaults, http, base_url: m.base_url, provider, oracle: new Oracle(), resource_defs: defs, builder,
      credential_env: credentialEnvName(target, credentialEnv), run_dir: runDir,
    });
    const mgr = executor.resources;
    mgr.created = pending.map(([kind, rid]) => new Resource(kind, rid));
    problems = await mgr.teardown();
  } finally {
    http.close();
  }
  for (const p of problems) echo(`still not deleted: ${p.kind} ${p.resource_id}: ${p.message}`);
  echo(`cleanup: ${pending.length - problems.length} of ${pending.length} deleted`);
  return problems.length ? EXIT_FAILURES : EXIT_OK;
}
