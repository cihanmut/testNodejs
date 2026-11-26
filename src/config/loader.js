// Loads config/apitest.yaml (+ credentials.local.yaml) into typed objects.
import fs from 'node:fs';
import path from 'node:path';
import { yamlLoad } from '../util/yaml.js';
import {
  AppConfig, AuthConfig, ConfigError, Expectations, LEVELS, buildSection, defaultsDefaults, envelopeDefaults,
  exportsDefaults, filtersDefaults, profileDefaults, targetDefaults,
} from './models.js';

export const DEFAULT_CONFIG_PATH = path.join('config', 'apitest.yaml');
export const CREDENTIALS_FILE_NAME = 'credentials.local.yaml';
export const PUBLIC_DEMO_MAX_RPS = 2.0;

function readYaml(file) {
  let data;
  try {
    data = yamlLoad(fs.readFileSync(file, 'utf8'));
  } catch (exc) {
    throw new ConfigError(`${file}: invalid YAML: ${exc.message}`);
  }
  if (data === null) return {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new ConfigError(`${file}: top level must be a mapping`);
  return data;
}

function resolvePath(root, value) {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.join(root, value);
}

export function loadConfig(configPath = null) {
  let file = configPath || DEFAULT_CONFIG_PATH;
  if (!fs.existsSync(file)) throw new ConfigError(`config file not found: ${file}`);
  file = path.resolve(file);
  const configDir = path.dirname(file);
  const projectRoot = path.dirname(configDir);
  const data = readYaml(file);

  const unknown = Object.keys(data).filter((k) => !['defaults', 'profiles', 'targets'].includes(k)).sort();
  if (unknown.length) throw new ConfigError(`${file}: unknown top-level key(s): ${unknown.join(', ')}`);

  const defaults = buildSection(defaultsDefaults(), data.defaults, 'defaults');
  if (!LEVELS.includes(defaults.level)) throw new ConfigError(`defaults.level must be one of ${LEVELS.join(', ')}`);

  const profiles = {};
  for (const [name, pdata] of Object.entries(data.profiles || {})) {
    const prof = buildSection(profileDefaults(), { name, ...(pdata || {}) }, `profiles.${name}`);
    if (name === 'public-demo') {
      // Hard limits for shared public servers; config cannot loosen them.
      prof.rate_limit_rps = Math.min(Number(prof.rate_limit_rps), PUBLIC_DEMO_MAX_RPS);
      prof.own_resources_only = true;
      prof.allow_injection = false;
    }
    profiles[name] = prof;
  }
  if (!('public-demo' in profiles)) profiles['public-demo'] = { ...profileDefaults(), name: 'public-demo' };

  const targets = {};
  for (const [name, raw] of Object.entries(data.targets || {})) {
    const tdata = { ...(raw || {}) };
    const where = `targets.${name}`;
    if (!('spec' in tdata)) throw new ConfigError(`${where}: 'spec' is required`);
    const auth = new AuthConfig(checked(tdata.auth, `${where}.auth`, Object.keys(new AuthConfig())));
    const expectations = new Expectations(checked(tdata.expectations, `${where}.expectations`, ['reject', 'per_tag', 'per_operation']));
    const exports = buildSection(exportsDefaults(), tdata.exports, `${where}.exports`);
    const envelope = buildSection(envelopeDefaults(), tdata.envelope, `${where}.envelope`);
    const filters = buildSection(filtersDefaults(), tdata.filters, `${where}.filters`);
    for (const [k, v] of Object.entries(filters)) {
      if (typeof v === 'string') filters[k] = [v];
      else if (!Array.isArray(v)) throw new ConfigError(`${where}.filters.${k} must be a list`);
      filters[k] = filters[k].map(String);
    }
    delete tdata.auth;
    delete tdata.expectations;
    delete tdata.exports;
    delete tdata.envelope;
    delete tdata.filters;
    for (const key of ['overrides', 'known_issues', 'resources']) tdata[key] = resolvePath(projectRoot, tdata[key]);
    const rules = tdata.rules || [];
    delete tdata.rules;
    const rulePaths = (typeof rules === 'string' ? [rules] : rules).map((r) => resolvePath(projectRoot, r));
    if (defaults.rules_file && (tdata.use_default_rules ?? true)) rulePaths.unshift(resolvePath(projectRoot, defaults.rules_file));
    let spec = String(tdata.spec);
    delete tdata.spec;
    if (!spec.includes('://')) spec = resolvePath(projectRoot, spec);
    const tgt = buildSection(targetDefaults(), { name, spec, ...tdata, rules: rulePaths, auth, expectations, exports, envelope, filters }, where);
    if (!(tgt.profile in profiles)) throw new ConfigError(`${where}: unknown profile '${tgt.profile}'`);
    if (!['reject', 'accept', 'ignore'].includes(tgt.unknown_fields)) throw new ConfigError(`${where}: unknown_fields must be reject, accept or ignore`);
    if (typeof tgt.allow_null_in_responses !== 'boolean') throw new ConfigError(`${where}: allow_null_in_responses must be true or false`);
    for (const p of tgt.rules) {
      if (!fs.existsSync(p)) throw new ConfigError(`${where}: rules file not found: ${p}`);
    }
    targets[name] = tgt;
  }

  const creds = path.join(configDir, CREDENTIALS_FILE_NAME);
  return new AppConfig({
    config_dir: configDir,
    project_root: projectRoot,
    defaults,
    profiles,
    targets,
    credentials_file: fs.existsSync(creds) ? creds : null,
  });
}

function checked(data, where, allowed) {
  const unknown = Object.keys(data || {}).filter((k) => !allowed.includes(k)).sort();
  if (unknown.length) throw new ConfigError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  return data || {};
}

/** Return [credential, source description]. Never logs the value.
 *  Order: --credential > --credential-env > target env var > credentials.local.yaml. */
export function resolveCredential(cfg, target, flagValue = null, flagEnv = null) {
  if (flagValue) return [flagValue, '--credential flag'];
  if (flagEnv) {
    const value = process.env[flagEnv];
    if (value) return [value, `env ${flagEnv}`];
    return [null, `env ${flagEnv} (not set)`];
  }
  if (target.auth.env && process.env[target.auth.env]) return [process.env[target.auth.env], `env ${target.auth.env}`];
  if (cfg.credentials_file) {
    const data = readYaml(cfg.credentials_file);
    let value = data[target.name];
    if (value && typeof value === 'object') value = value.credential;
    if (value) return [String(value), CREDENTIALS_FILE_NAME];
  }
  return [null, 'not given'];
}

/** Name used in generated curl commands instead of the credential value. */
export function credentialEnvName(target, flagEnv = null) {
  return flagEnv || target.auth.env || 'API_CREDENTIAL';
}
