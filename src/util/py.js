// Small helpers that reproduce Python behaviour the tool relies on: repr()/str() formatting for titles
// and reports, fnmatch globs, Python-style regexes, deep copies, counters and deep equality.
import { dumps, isPlainObject } from './json.js';

// ------------------------------------------------------------------------------------- repr / str
export function reprStr(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 32 || c === 127) out += '\\x' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + quote;
}

/** Python repr() for the value kinds the tool uses. Objects with their own repr() method use it. */
export function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'string') return reprStr(v);
  if (Buffer.isBuffer(v)) return "b'" + [...v].map((b) => (b >= 32 && b < 127 && b !== 39 && b !== 92 ? String.fromCharCode(b) : '\\x' + b.toString(16).padStart(2, '0'))).join('') + "'";
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  if (isPlainObject(v)) return '{' + Object.entries(v).map(([k, x]) => reprStr(k) + ': ' + pyRepr(x)).join(', ') + '}';
  if (typeof v.repr === 'function') return v.repr();
  return String(v);
}

/** Python str(): like repr() except that strings are shown without quotes. */
export function pyStr(v) {
  return typeof v === 'string' ? v : pyRepr(v);
}

// ------------------------------------------------------------------------------------- fnmatch
const globCache = new Map();

function globToRegExp(pat) {
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') out += '.*';
    else if (c === '?') out += '.';
    else if (c === '[') {
      let j = i + 1;
      if (pat[j] === '!') j++;
      if (pat[j] === ']') j++;
      while (j < pat.length && pat[j] !== ']') j++;
      if (j >= pat.length) out += '\\[';
      else {
        let stuff = pat.slice(i + 1, j).replace(/\\/g, '\\\\');
        if (stuff[0] === '!') stuff = '^' + stuff.slice(1);
        else if (stuff[0] === '^') stuff = '\\' + stuff;
        out += '[' + stuff + ']';
        i = j;
      }
    } else out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp('^(?:' + out + ')$', 's');
}

/** fnmatch.fnmatchcase: shell-style glob, case-sensitive, whole string. */
export function fnmatch(name, pattern) {
  let re = globCache.get(pattern);
  if (!re) {
    re = globToRegExp(String(pattern));
    globCache.set(pattern, re);
  }
  return re.test(String(name));
}

// ------------------------------------------------------------------------------------- regex
const reCache = new Map();

/** Compile a Python-style regex (as written in YAML rules / specs) to a JS RegExp.
 *  Supports leading inline flags like (?i), named groups (?P<name>...), \A and \Z. Throws on bad input. */
export function pyRegex(pattern) {
  const key = String(pattern);
  let re = reCache.get(key);
  if (re) return re;
  let src = key;
  let flags = '';
  const m = /^\(\?([aiLmsux]+)\)/.exec(src);
  if (m) {
    src = src.slice(m[0].length);
    if (m[1].includes('i')) flags += 'i';
    if (m[1].includes('m')) flags += 'm';
    if (m[1].includes('s')) flags += 's';
  }
  src = src.replace(/\(\?P</g, '(?<').replace(/\(\?P=(\w+)\)/g, '\\k<$1>').replace(/\\A/g, '^').replace(/\\Z/g, '$(?![\\s\\S])');
  re = new RegExp(src, flags);
  reCache.set(key, re);
  return re;
}

/** re.search(pattern, text) -> boolean */
export function reSearch(pattern, text) {
  return pyRegex(pattern).test(String(text));
}

// ------------------------------------------------------------------------------------- copies
/** Deep copy of plain data (objects, arrays). Class instances (sentinels, FileValue, ResourceRef, Buffers)
 *  are immutable in this code base and are shared, like Python's deepcopy of frozen dataclasses. */
export function deepCopy(v) {
  if (Array.isArray(v)) return v.map(deepCopy);
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = deepCopy(x);
    return out;
  }
  return v;
}

/** Structural equality for plain data (Python ==). Dict key order does not matter. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'bigint' || typeof b === 'bigint') return typeof a !== 'object' && typeof b !== 'object' && a == b; // eslint-disable-line eqeqeq
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  if (a && b && typeof a.equals === 'function') return a.equals(b);
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  return false;
}

// ------------------------------------------------------------------------------------- counters
export class Counter extends Map {
  add(key, n = 1) {
    this.set(key, (this.get(key) || 0) + n);
    return this;
  }

  getn(key) {
    return this.get(key) || 0;
  }

  static of(items) {
    const c = new Counter();
    for (const x of items) c.add(x);
    return c;
  }

  /** entries sorted by count, descending; ties keep insertion order (like collections.Counter). */
  mostCommon(n) {
    const out = [...this.entries()].sort((a, b) => b[1] - a[1]);
    return n === undefined ? out : out.slice(0, n);
  }

  toObject(entries = [...this.entries()]) {
    return Object.fromEntries(entries);
  }
}

// ------------------------------------------------------------------------------------- misc
export const sleep = (s) => new Promise((resolve) => setTimeout(resolve, Math.max(0, s * 1000)));

export function hasKey(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

/** Python sorted() for strings / numbers. */
export function sorted(items, key = (x) => x) {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (Array.isArray(ka)) {
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return 0;
    }
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Stable key for sets/maps of JSON-like values (ids may be numbers, BigInts or strings). */
export const jkey = (v) => dumps(v);

/** Python's '%.0f' / round() style rounding for display (round half to even). */
export function roundHalfEven(x, digits = 0) {
  const f = 10 ** digits;
  const n = x * f;
  const r = Math.round(n);
  const diff = Math.abs(n % 1);
  if (Math.abs(diff - 0.5) < 1e-9) return (r % 2 === 0 ? r : r - 1) / f;
  return r / f;
}
