// The ONLY module that sends HTTP requests.
//
// Guarantees:
// - retries happen only on network errors, never on an HTTP status;
// - non-idempotent requests are retried only when the connection was never established;
// - redirects are not followed.
// Built on node:http / node:https only (no npm packages). Supports a proxy (config `proxy` or the
// HTTPS_PROXY / HTTP_PROXY / NO_PROXY environment variables, like the Python version) and a corporate
// CA bundle (config `ca_bundle`, added to Node's built-in root certificates).
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { sleep as realSleep } from '../util/py.js';

export const MAX_STORED_BODY = 8192;
export const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
export const USER_AGENT = 'apitest/0.1 (API test tool)';

/** A transport-level failure (no HTTP response). connectFailed = the request never reached the server. */
export class NetworkError extends Error {
  constructor(name, message, { timeout = false, connectFailed = false } = {}) {
    super(message);
    this.name = name;
    this.timeout = timeout;
    this.connectFailed = connectFailed;
  }
}

export class ResponseRecord {
  constructor({ status = null, headers = {}, body = Buffer.alloc(0), elapsed_ms = 0, error = null, error_kind = null, attempts = 1 } = {}) {
    this.status = status;
    this.headers = headers;
    this.body = Buffer.isBuffer(body) ? body : Buffer.from(body);
    this.elapsed_ms = elapsed_ms;
    this.error = error;
    this.error_kind = error_kind; // timeout | network
    this.attempts = attempts;
  }

  get content_type() {
    return (this.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  }

  text(limit = MAX_STORED_BODY) {
    let data = this.body.subarray(0, limit);
    let text = null;
    const dec = new TextDecoder('utf-8', { fatal: true });
    for (let cut = 0; cut < 4 && text === null; cut++) {
      if (cut && this.body.length <= limit) break; // only a truncation may split a character
      try {
        text = dec.decode(data.subarray(0, data.length - cut));
      } catch {
        text = null;
      }
    }
    if (text === null) return `<${this.body.length} bytes binary>`;
    if (this.body.length > limit) text += `\n… truncated (${this.body.length} bytes total)`;
    return text;
  }
}

/** Simple minimum-interval limiter (requests per second). Shared by all requests of a run. */
export class RateLimiter {
  constructor(rps, clock = () => performance.now() / 1000, sleepFn = realSleep) {
    this.interval = rps && rps > 0 ? 1.0 / rps : 0.0;
    this.clock = clock;
    this.sleepFn = sleepFn;
    this.next = 0.0;
  }

  async wait() {
    if (!this.interval) return;
    let now = this.clock();
    if (now < this.next) {
      await this.sleepFn(this.next - now);
      now = this.next;
    }
    this.next = now + this.interval;
  }
}

// ------------------------------------------------------------------------------------- proxy
function envProxy(protocol) {
  const e = process.env;
  const v = protocol === 'https:' ? e.HTTPS_PROXY || e.https_proxy || e.ALL_PROXY || e.all_proxy
    : e.HTTP_PROXY || e.http_proxy || e.ALL_PROXY || e.all_proxy;
  return v || null;
}

function noProxy(host) {
  const list = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return list.some((entry) => entry === '*' || host === entry.replace(/^\./, '') || host.endsWith('.' + entry.replace(/^\./, '')));
}

function proxyAuth(proxyUrl) {
  if (!proxyUrl.username) return {};
  const cred = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
  return { 'Proxy-Authorization': 'Basic ' + Buffer.from(cred).toString('base64') };
}

function decode(body, encoding) {
  const enc = (encoding || '').trim().toLowerCase();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(body);
    if (enc === 'deflate') {
      try {
        return zlib.inflateSync(body);
      } catch {
        return zlib.inflateRawSync(body);
      }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(body);
  } catch {
    return body; // undecodable: keep the raw bytes
  }
  return body;
}

/** Default transport: one HTTP exchange with node:http(s). Never follows redirects. */
export function nodeTransport({ timeoutConnect = 5, timeoutRead = 30, proxy = null, caBundle = null } = {}) {
  const ca = caBundle ? [...tls.rootCertificates, fs.readFileSync(caBundle, 'utf8')] : undefined;
  const agents = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true, ca }) };

  function exchange({ method, url, headers, body }) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const isHttps = target.protocol === 'https:';
      const host = target.hostname.replace(/^\[|\]$/g, '');
      const port = target.port || (isHttps ? 443 : 80);
      const proxyText = noProxy(host) ? null : proxy || envProxy(target.protocol);
      const proxyUrl = proxyText ? new URL(proxyText.includes('://') ? proxyText : 'http://' + proxyText) : null;
      let connected = false;
      let settled = false;
      const timers = [];
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        fn(v);
      };
      const fail = (err) => {
        if (err instanceof NetworkError) return done(reject, err);
        const code = err && err.code ? ` (${err.code})` : '';
        const connectFailed = !connected;
        done(reject, new NetworkError(connectFailed ? 'ConnectError' : 'NetworkError', `${err && err.message ? err.message : err}${code}`, { connectFailed }));
      };
      const opts = { method, headers: { ...headers }, timeout: timeoutRead * 1000 };
      if (body) opts.headers['Content-Length'] = String(body.length);

      const start = (req) => {
        timers.push(setTimeout(() => {
          if (!connected) {
            req.destroy();
            done(reject, new NetworkError('ConnectTimeout', `connect timeout after ${timeoutConnect}s`, { timeout: true, connectFailed: true }));
          }
        }, timeoutConnect * 1000));
        req.on('socket', (sock) => {
          const mark = () => { connected = true; };
          if (!sock.connecting) mark();
          else sock.once(isHttps && !proxyUrl ? 'secureConnect' : 'connect', mark);
        });
        req.on('timeout', () => {
          req.destroy();
          done(reject, new NetworkError(connected ? 'ReadTimeout' : 'ConnectTimeout', `timed out after ${timeoutRead}s`, { timeout: true, connectFailed: !connected }));
        });
        req.on('error', fail);
        req.on('response', (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('error', fail);
          res.on('end', () => {
            const hdrs = {};
            for (const [k, v] of Object.entries(res.headers)) hdrs[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
            done(resolve, { status: res.statusCode, headers: hdrs, body: decode(Buffer.concat(chunks), hdrs['content-encoding']) });
          });
        });
        if (body) req.write(body);
        req.end();
      };

      if (proxyUrl && isHttps) {
        // HTTPS through a proxy: CONNECT tunnel, then TLS to the target over the tunnel
        const connectReq = http.request({
          host: proxyUrl.hostname, port: proxyUrl.port || 80, method: 'CONNECT', path: `${host}:${port}`,
          headers: { Host: `${host}:${port}`, ...proxyAuth(proxyUrl) },
        });
        timers.push(setTimeout(() => {
          connectReq.destroy();
          done(reject, new NetworkError('ConnectTimeout', `proxy connect timeout after ${timeoutConnect}s`, { timeout: true, connectFailed: true }));
        }, timeoutConnect * 1000));
        connectReq.on('error', (e) => done(reject, new NetworkError('ProxyError', `proxy ${proxyUrl.host}: ${e.message}`, { connectFailed: true })));
        connectReq.on('connect', (res, socket) => {
          if (res.statusCode !== 200) {
            socket.destroy();
            done(reject, new NetworkError('ProxyError', `proxy ${proxyUrl.host} refused CONNECT: HTTP ${res.statusCode}`, { connectFailed: true }));
            return;
          }
          timers.forEach(clearTimeout);
          timers.length = 0;
          const req = https.request({
            ...opts, host, port, path: target.pathname + target.search, agent: false, servername: host,
            createConnection: () => tls.connect({ socket, servername: host, ca }),
          });
          start(req);
        });
        connectReq.end();
        return;
      }
      if (proxyUrl) {
        // plain HTTP through a proxy: absolute URL as the request target
        start(http.request({ ...opts, host: proxyUrl.hostname, port: proxyUrl.port || 80, path: url, headers: { ...opts.headers, Host: target.host, ...proxyAuth(proxyUrl) } }));
        return;
      }
      const mod = isHttps ? https : http;
      start(mod.request({ ...opts, host, port, path: target.pathname + target.search, agent: agents[target.protocol] }));
    });
  }

  exchange.close = () => Object.values(agents).forEach((a) => a.destroy());
  return exchange;
}

export class SafeHttpClient {
  constructor({
    timeout_connect = 5.0, timeout_read = 30.0, retries = 2, backoff_s = 2.0, rate_limiter = null, proxy = null, ca_bundle = null,
    transport = null, user_agent = USER_AGENT, sleep = realSleep,
  } = {}) {
    this.retries = Math.max(0, retries);
    this.backoff_s = backoff_s;
    this.rate_limiter = rate_limiter || new RateLimiter(null);
    this._sleep = sleep;
    this.requests_sent = 0;
    this.user_agent = user_agent;
    this._transport = transport || nodeTransport({ timeoutConnect: timeout_connect, timeoutRead: timeout_read, proxy, caBundle: ca_bundle });
  }

  // -- sending ----------------------------------------------------------------------------------
  async send(method, url, headers = null, content = null) {
    method = method.toUpperCase();
    let attempt = 0;
    for (;;) {
      attempt += 1;
      await this.rate_limiter.wait();
      const start = performance.now();
      try {
        const hdrs = { 'User-Agent': this.user_agent, 'Accept-Encoding': 'gzip, deflate', ...(headers || {}) };
        const resp = await this._transport({ method, url, headers: hdrs, body: content === null || content === undefined ? null : Buffer.from(content) });
        const elapsed = performance.now() - start;
        this.requests_sent += 1;
        const lower = {};
        for (const [k, v] of Object.entries(resp.headers || {})) lower[k.toLowerCase()] = String(v);
        return new ResponseRecord({ status: resp.status, headers: lower, body: resp.body || Buffer.alloc(0), elapsed_ms: Math.round(elapsed * 10) / 10, attempts: attempt });
      } catch (exc) {
        if (!(exc instanceof NetworkError)) throw exc;
        const elapsed = performance.now() - start;
        const kind = exc.timeout ? 'timeout' : 'network';
        const retryAllowed = IDEMPOTENT.has(method) || exc.connectFailed;
        if (attempt <= this.retries && retryAllowed) {
          await this._sleep(this.backoff_s * attempt);
          continue;
        }
        return new ResponseRecord({ status: null, error: `${exc.name}: ${exc.message}`, error_kind: kind, elapsed_ms: Math.round(elapsed * 10) / 10, attempts: attempt });
      }
    }
  }

  get(url, headers = null) {
    return this.send('GET', url, headers);
  }

  close() {
    if (this._transport && typeof this._transport.close === 'function') this._transport.close();
  }
}
