// Typed configuration objects (config/apitest.yaml). Each section has a fixed set of keys: unknown keys
// are rejected by the loader so typos never pass silently.

export const LEVELS = Object.freeze(['smoke', 'standard', 'full']);

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Build an object from defaults + data, rejecting unknown keys (Python: dataclass(**data)). */
export function buildSection(defaults, data, where) {
  data = { ...(data || {}) };
  const unknown = Object.keys(data).filter((k) => !(k in defaults)).sort();
  if (unknown.length) throw new ConfigError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  return { ...defaults, ...data };
}

export const authDefaults = () => ({
  header: null, // e.g. TGT, api_key; null = target has no auth
  env: null, // env var holding the credential
  prefix: '', // e.g. "Bearer " if the header value carries a prefix
  expired_env: null, // optional env var with a known-expired credential
  scheme_map: {}, // security scheme -> header name
  ignored_schemes: [],
  auth_required: [], // operationId / "METHOD /path" globs
  auth_not_required: [],
  unauth_expect: [401, 403],
  login_redirect_pattern: null,
});

export class AuthConfig {
  constructor(data = {}) {
    Object.assign(this, buildSection(authDefaults(), data, 'auth'));
  }
}

export class Expectations {
  constructor(data = {}) {
    Object.assign(this, buildSection({ reject: [400, 404, 405, 409, 415, 422], per_tag: {}, per_operation: {} }, data, 'expectations'));
  }

  rejectCodes(operationId, tags) {
    const po = this.per_operation[operationId];
    if (po && 'reject' in po) return [...po.reject];
    for (const tag of tags) {
      const pt = this.per_tag[tag];
      if (pt && 'reject' in pt) return [...pt.reject];
    }
    return [...this.reject];
  }
}

export const profileDefaults = () => ({ name: '', rate_limit_rps: 1.0, concurrency: 1, own_resources_only: true, allow_injection: false });
export const exportsDefaults = () => ({ tag_pattern: null, type_field: null });
/** Error envelope inside a 2xx response (e.g. {"resultCode": "E1", ...} with HTTP 200). */
/** Default operation filter of a target, used when no --tag/--path/--method/--operation flag is given. */
export const filtersDefaults = () => ({ tags: [], paths: [], methods: [], operations: [] });
export const envelopeDefaults = () => ({ path: null, ok_values: null, fail_if_present: false });

export const targetDefaults = () => ({
  name: '',
  spec: '',
  base_url: null,
  profile: 'public-demo',
  auth: null,
  expectations: null,
  overrides: null,
  known_issues: null,
  resources: null,
  exports: null,
  envelope: null,
  filters: null, // default operation filter (see filtersDefaults)
  rules: [], // extra domain-rule files for this target
  use_default_rules: true, // also load defaults.rules_file
  unknown_fields: 'ignore', // unknown body field: reject | accept | ignore (no 5xx)
  timezone_offset: '+03:00',
});

export const defaultsDefaults = () => ({
  seed: 42,
  level: 'standard',
  timeout_connect: 5.0,
  timeout_read: 30.0,
  network_retries: 2,
  retry_backoff_s: 2.0,
  response_time_warn_ms: 3000,
  proxy: null,
  ca_bundle: null,
  include_exports: false,
  health_baseline_window: 10,
  health_baseline_fail_ratio: 0.5,
  health_max_consecutive_errors: 20,
  credential_expiry_consecutive: 3,
  rules_file: 'config/rules/domain_rules.yaml',
  report_formats: ['html', 'junit', 'csv', 'xlsx'],
});

export class AppConfig {
  constructor({ config_dir, project_root, defaults, profiles, targets, credentials_file = null }) {
    Object.assign(this, { config_dir, project_root, defaults, profiles, targets, credentials_file });
  }

  target(name) {
    if (!(name in this.targets)) {
      const known = Object.keys(this.targets).sort().join(', ') || '(none)';
      throw new ConfigError(`unknown target '${name}'. Known targets: ${known}`);
    }
    return this.targets[name];
  }

  profileFor(target) {
    if (!(target.profile in this.profiles)) throw new ConfigError(`target '${target.name}' uses unknown profile '${target.profile}'`);
    return this.profiles[target.profile];
  }
}
