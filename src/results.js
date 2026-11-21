// Result model shared by executor, oracle and reporters. Everything here is JSON-serialisable and already
// masked: no credential value ever reaches a result object. The JSON layout is identical to the Python
// version's (results.jsonl / run.json).

export const PASS = 'PASS';
export const FAIL = 'FAIL';
export const WARN = 'WARN';
export const KNOWN = 'KNOWN';
export const SKIPPED = 'SKIPPED';
export const ERROR = 'ERROR';
export const BASELINE_FAILED = 'BASELINE_FAILED';
export const STATUSES = Object.freeze([FAIL, BASELINE_FAILED, ERROR, WARN, KNOWN, SKIPPED, PASS]);
export const FAILING = new Set([FAIL, BASELINE_FAILED, ERROR]);

// finding categories (report sections)
export const DEFECT = 'defect';
export const AUTH = 'auth';
export const DOCUMENTATION = 'documentation';
export const CLEANUP = 'cleanup';
export const ENVIRONMENT = 'environment';

export class Finding {
  constructor(category, message, severity = 'warn') {
    this.category = category;
    this.message = message;
    this.severity = severity; // fail | warn | info
  }
}

export class RequestInfo {
  constructor(method, url, headers, body) {
    Object.assign(this, { method, url, headers, body });
  }
}

export class ResponseInfo {
  constructor(status, headers, body, content_type, elapsed_ms, error = null) {
    Object.assign(this, { status, headers, body, content_type, elapsed_ms, error });
  }
}

export class CaseResult {
  constructor({ case: c, operation, status, reason, findings = [], request = null, response = null, curl_bash = null, curl_ps = null, known_issue = null, final = true, timestamp = '' }) {
    this.case = c; // TestCase.summary()
    this.operation = operation; // operation_id, method, path, tags
    this.status = status;
    this.reason = reason;
    this.findings = findings;
    this.request = request;
    this.response = response;
    this.curl_bash = curl_bash;
    this.curl_ps = curl_ps;
    this.known_issue = known_issue;
    this.final = final; // false: may be retried on resume (credential expired, aborted)
    this.timestamp = timestamp;
  }

  toDict() {
    return {
      case: this.case,
      operation: this.operation,
      status: this.status,
      reason: this.reason,
      findings: this.findings.map((f) => ({ category: f.category, message: f.message, severity: f.severity })),
      request: this.request ? { ...this.request } : null,
      response: this.response ? { ...this.response } : null,
      curl_bash: this.curl_bash,
      curl_ps: this.curl_ps,
      known_issue: this.known_issue,
      final: this.final,
      timestamp: this.timestamp,
    };
  }

  static fromDict(d) {
    return new CaseResult({
      ...d,
      findings: (d.findings || []).map((f) => new Finding(f.category, f.message, f.severity)),
      request: d.request ? new RequestInfo(d.request.method, d.request.url, d.request.headers, d.request.body) : null,
      response: d.response ? new ResponseInfo(d.response.status, d.response.headers, d.response.body, d.response.content_type, d.response.elapsed_ms, d.response.error ?? null) : null,
    });
  }
}

export class CleanupProblem {
  constructor(kind, resource_id, message, curl_bash = null, curl_ps = null) {
    Object.assign(this, { kind, resource_id, message, curl_bash, curl_ps });
  }
}

export class EnvironmentHealth {
  constructor() {
    this.baselines_run = 0;
    this.baselines_ok = 0;
    this.server_errors = 0;
    this.timeouts = 0;
    this.network_errors = 0;
    this.aborted = false;
    this.abort_reason = null;
    this.credential_expired = false;
    this.notes = [];
  }
}

export const TOOL_VERSION = '0.3.0';

export function runMeta(init) {
  return {
    run_id: '', target: '', spec_title: '', spec_version: '', spec_sha256: '', spec_source: '', base_url: '', level: '', profile: '', seed: 42,
    filters: {}, include_exports: false, credential: '', credential_env: '', started: '', finished: '', state: 'running', requests_sent: 0,
    allow_injection: false, tool_version: `${TOOL_VERSION}-node`, ...init,
  };
}
