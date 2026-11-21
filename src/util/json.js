// Lossless JSON.
//
// JavaScript numbers lose precision above 2^53, but the tool works with int64 IDs (Petstore pet ids like
// 9123456789012345678) and int64 overflow test values. parseJson() therefore returns integers outside the
// safe range as BigInt, and dumps() writes BigInt as plain digits. Integers inside the safe range stay
// ordinary numbers, so `===` comparisons work across the code base (use normInt() for computed values).
//
// dumps() formats like Python's json.dumps (separators ", " and ": ", indent, sort_keys), so request
// bodies, reports and case descriptions look exactly like the Python version's.

const NUMBER_RE = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
const WS_RE = /[ \t\n\r]*/y;

export class JsonParseError extends SyntaxError {}

/** A JSON number kept as its original text (parseJson(..., {rawNumbers: true}), for pretty-printing a
 *  response exactly as the server sent it: 0.0 stays 0.0, 1.50 stays 1.50). */
export class RawNumber {
  constructor(text) {
    this.text = text;
  }
}

export function normInt(v) {
  if (typeof v === 'bigint' && v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
  return v;
}

export function parseJson(input, { rawNumbers = false } = {}) {
  const text = typeof input === 'string' ? input : Buffer.from(input).toString('utf8');
  let i = 0;
  const fail = (msg) => { throw new JsonParseError(`${msg} at position ${i}`); };
  const ws = () => { WS_RE.lastIndex = i; WS_RE.exec(text); i = WS_RE.lastIndex; };

  function str() {
    // text[i] === '"'; find the closing quote, then let the native parser decode escapes
    let j = i + 1;
    let simple = true;
    for (;;) {
      const c = text.charCodeAt(j);
      if (Number.isNaN(c)) fail('unterminated string');
      if (c === 34) break;
      if (c === 92) { simple = false; j += 2; continue; }
      if (c < 32) fail('control character in string');
      j++;
    }
    const raw = text.slice(i, j + 1);
    i = j + 1;
    return simple ? raw.slice(1, -1) : JSON.parse(raw);
  }

  function value() {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj = {};
      ws();
      if (text[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('expected property name');
        const key = str();
        ws();
        if (text[i] !== ':') fail("expected ':'");
        i++;
        const v = value();
        if (key === '__proto__') Object.defineProperty(obj, key, { value: v, writable: true, enumerable: true, configurable: true });
        else obj[key] = v;
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return obj; }
        fail("expected ',' or '}'");
      }
    }
    if (c === '[') {
      i++;
      const arr = [];
      ws();
      if (text[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value());
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return arr; }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return str();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(text);
    if (m) {
      i = NUMBER_RE.lastIndex;
      const tok = m[0];
      if (rawNumbers) return new RawNumber(tok);
      if (!m[1] && !m[2]) {
        const n = Number(tok);
        return Number.isSafeInteger(n) ? n : BigInt(tok);
      }
      return Number(tok);
    }
    fail('unexpected token');
  }

  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const out = value();
  ws();
  if (i < text.length) fail('unexpected data after JSON');
  return out;
}

export function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function numText(n) {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  return String(n);
}

const ASCII_ESCAPE = /[\u007f-￿]/g;

function strText(s, ensureAscii) {
  const out = JSON.stringify(s);
  return ensureAscii ? out.replace(ASCII_ESCAPE, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')) : out;
}

/** Python json.dumps look-alike. Throws TypeError for values JSON cannot represent. */
export function dumps(value, { indent = null, sortKeys = false, ensureAscii = false } = {}) {
  const pad = typeof indent === 'number' ? ' '.repeat(indent) : indent;
  function enc(v, level) {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'number') return numText(v);
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'string') return strText(v, ensureAscii);
    if (v instanceof RawNumber) return v.text;
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      const items = v.map((x) => enc(x, level + 1));
      if (pad === null) return '[' + items.join(', ') + ']';
      const inner = '\n' + pad.repeat(level + 1);
      return '[' + inner + items.join(',' + inner) + '\n' + pad.repeat(level) + ']';
    }
    if (isPlainObject(v)) {
      let keys = Object.keys(v);
      if (sortKeys) keys = keys.sort();
      if (!keys.length) return '{}';
      const items = keys.map((k) => strText(k, ensureAscii) + ': ' + enc(v[k], level + 1));
      if (pad === null) return '{' + items.join(', ') + '}';
      const inner = '\n' + pad.repeat(level + 1);
      return '{' + inner + items.join(',' + inner) + '\n' + pad.repeat(level) + '}';
    }
    if (typeof v.toJSON === 'function') return enc(v.toJSON(), level);
    throw new TypeError(`Object of type ${v?.constructor?.name ?? typeof v} is not JSON serializable`);
  }
  return enc(value, 0);
}

/** Compact one-line JSON for .jsonl files (same separators as Python's json.dumps). */
export const jsonLine = (v) => dumps(v);
