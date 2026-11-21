// Shared test helpers (Python conftest.py equivalent).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/loader.js';
import { loadResourceDefs } from '../src/resources/definitions.js';
import { ResourceManager } from '../src/resources/manager.js';
import { RateLimiter } from '../src/execution/http.js';
import { buildPlan } from '../src/generators/plan.js';
import { loadSpecSource } from '../src/spec/loader.js';
import { normalize } from '../src/spec/normalize.js';
import { parseJson } from '../src/util/json.js';
import { loadYamlFile } from '../src/util/yaml.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
export const CONFIG = path.join(ROOT, 'config', 'apitest.yaml');
/** test-only config with the offline Petstore targets (Petstore is not a real target; only a test fake) */
export const PET_CONFIG = path.join(ROOT, 'tests', 'config', 'apitest.yaml');
export const KEY = 'special-key-0123456789'; // long enough that masking keeps only the last 4 chars

let cfgCache = null;
export const cfg = () => (cfgCache ||= loadConfig(CONFIG));
let petCfgCache = null;
export const petCfg = () => (petCfgCache ||= loadConfig(PET_CONFIG));

const apis = {};
async function api(name, file, pattern = null) {
  return (apis[name] ||= normalize(await loadSpecSource(path.join(FIXTURES, file)), pattern));
}
export const epiasApi = () => api('epias', 'epias_electricity_swagger.json', '-export-controller$');
export const petv3Api = () => api('v3', 'petstore_v3_openapi.json');
export const petv2Api = () => api('v2', 'petstore_v2_swagger.json');
export const simpleApi = () => api('simple', 'apichallenges_simpleapi_openapi30.json');

export function plan(c, apiSpec, target, { level = 'standard', runId = 'R1', ...kw } = {}) {
  const t = c.target(target);
  return buildPlan(apiSpec, t, c.profileFor(t), {
    level, runId, seed: c.defaults.seed, overrides: loadYamlFile(t.overrides) || {}, resources: loadResourceDefs(t.resources), ...kw,
  });
}

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apitest-'));
}

/** latest record per case id from results.jsonl */
export function results(runDir) {
  const latest = new Map();
  for (const line of fs.readFileSync(path.join(runDir, 'results.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = parseJson(line);
    latest.set(r.case.id, r);
  }
  return [...latest.values()];
}

export const readJson = (file) => parseJson(fs.readFileSync(file, 'utf8'));

/** No rate limit, no verify backoff (Python: the autouse no_rate_limit fixture). */
export function fast() {
  RateLimiter.prototype.wait = async () => {};
  ResourceManager.VERIFY_BACKOFF_S = 0;
}

/** Capture CLI output (Python: click's CliRunner). */
export async function runCli(main, argv) {
  const lines = [];
  const code = await main(argv, { out: (s) => lines.push(s), err: (s) => lines.push(s) });
  return { code, output: lines.join('\n') };
}
